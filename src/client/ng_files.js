/* global angular */
'use strict';

var _ = require('lodash');
var util = require('util');
var moment = require('moment');
var size_utils = require('../util/size_utils');
var mgmt_api = require('../api/mgmt_api');
var edge_node_api = require('../api/edge_node_api');
var ObjectClient = require('../api/object_client');
var SliceReader = require('../util/slice_reader');
var concat_stream = require('concat-stream');
var EventEmitter = require('events').EventEmitter;
var mgmt_client = new mgmt_api.Client({
    path: '/api/mgmt_api/',
});
var edge_node_client = new edge_node_api.Client({
    path: '/api/edge_node_api/',
});
var object_client = new ObjectClient({
    path: '/api/object_api/',
});

var ng_app = angular.module('ng_app');




ng_app.controller('UploadCtrl', [
    '$scope', '$http', '$q', '$window', '$timeout', 'nbAlertify', '$sce', 'nbFiles',
    function($scope, $http, $q, $window, $timeout, nbAlertify, $sce, nbFiles) {
        $scope.nav.active = 'upload';

        $scope.click_browse = function(event) {
            var chooser = angular.element('<input type="file">');
            chooser.on('change', function(e) {
                $scope.file = e.target.files[0];
                $scope.safe_apply();
            });
            chooser.click();
        };

        $scope.click_upload = function(event) {
            var bucket = nbFiles.bucket;
            if (!bucket || !$scope.file) {
                return;
            }
            $scope.uploading = true;
            $scope.parts = [];
            var apply_timeout;
            object_client.events = object_client.events || new EventEmitter();
            object_client.events.on('part', function(part) {
                console.log('emitter part', part);
                $scope.parts.push(part);
                // throttling down the ng scope apply
                if (!apply_timeout) {
                    apply_timeout = $timeout(function() {
                        apply_timeout = null;
                    }, 500);
                }
            });
            return nbFiles.upload_file($scope.file, bucket).then(
                function() {
                    $scope.upload_done = true;
                },
                function() {
                    $scope.uploading = false;
                }
            );

        };


    }
]);



ng_app.controller('DownloadCtrl', [
    '$scope', '$http', '$q', '$window', '$timeout', 'nbAlertify', '$sce', 'nbFiles',
    function($scope, $http, $q, $window, $timeout, nbAlertify, $sce, nbFiles) {

        $scope.nav.active = 'download';


    }
]);



ng_app.factory('nbFiles', [
    '$http', '$q', '$window', '$timeout', '$sce', 'nbAlertify', 'nbServerData', '$rootScope',
    function($http, $q, $window, $timeout, $sce, nbAlertify, nbServerData, $rootScope) {
        var $scope = {};

        $scope.refresh = refresh;
        $scope.create_bucket = create_bucket;
        $scope.click_object = click_object;
        $scope.upload_file = upload_file;

        init();

        function init() {
            return refresh().then(
                function() {
                    if (!$scope.buckets.length) {
                        // create a first bucket if none
                        var name = nbServerData.account_email.split('@')[0];
                        return $q.when(object_client.create_bucket({
                            bucket: name
                        })).then(refresh);
                    }
                }
            );
        }

        function refresh() {
            return load_buckets();
        }


        function create_bucket() {
            return nbAlertify.prompt('Enter name for new bucket').then(
                function(str) {
                    if (!str) {
                        return;
                    }
                    return $q.when(object_client.create_bucket({
                        bucket: str
                    })).then(load_buckets).then(
                        function() {
                            $scope.bucket = $scope.buckets_by_name[str];
                        }
                    );
                }
            );
        }


        function click_object(object) {
            console.log('click_object', object);
            $scope.video_src = $scope.object_src = null;
            var url = read_as_media_stream(object);
            if (url) {
                $scope.video_src = $sce.trustAsResourceUrl(url);
                return;
            }
            return $q.when(read_entire_object(object)).then(
                function(data) {
                    console.log('OBJECT DATA', data.length);
                    var blob = new $window.Blob([data]);
                    var url = $window.URL.createObjectURL(blob);
                    $scope.object_src = $sce.trustAsResourceUrl(url);
                }
            );
        }

        function read_entire_object(object) {
            var object_path = {
                bucket: object.bucket.name,
                key: object.key,
            };
            var defer = $q.defer();
            var stream = concat_stream(defer.resolve);
            stream.once('error', defer.reject);
            object_client.open_read_stream(object_path).pipe(stream);
            return defer.promise;
        }

        function read_as_media_stream(object) {
            if (!object.key.match(/.*\.(webm)/)) {
                return;
            }
            var object_path = {
                bucket: object.bucket.name,
                key: object.key,
            };
            var ms = new $window.MediaSource();
            ms.addEventListener('sourceopen', function(e) {
                // TODO need to have content type, and check support for types
                var source_buffer = ms.addSourceBuffer('video/webm; codecs="vp8, vorbis"');
                var stream = object_client.open_read_stream(object_path);
                var video = $window.document.getElementsByTagName('video')[0];
                video.addEventListener('progress', function() {
                    stream.resume();
                });
                stream.on('data', function(data) {
                    console.log('STREAM DATA', data.length);
                    if (source_buffer.updating) {
                        stream.pause();
                    }
                    source_buffer.appendBuffer(data.toArrayBuffer());
                });
                stream.once('finish', function() {
                    console.log('STREAM FINISH');
                    ms.endOfStream();
                });
                stream.once('error', function(err) {
                    console.log('STREAM ERROR', err);
                    ms.endOfStream(err);
                });
            }, false);
            return $window.URL.createObjectURL(ms);
        }

        function upload_file(file, bucket) {
            console.log('upload', file);
            var object_path = {
                bucket: bucket.name,
                key: file.name + '_' + Date.now().toString(),
            };
            var create_params = _.clone(object_path);
            create_params.size = file.size;
            var start_time = Date.now();
            return $q.when(object_client.create_multipart_upload(create_params)).then(
                function() {
                    var defer = $q.defer();
                    var reader = new SliceReader(file, {
                        highWaterMark: size_utils.MEGABYTE,
                        FileReader: $window.FileReader,
                    });
                    var writer = object_client.open_write_stream(object_path);
                    var stream = reader.pipe(writer);
                    stream.once('error', defer.reject);
                    stream.once('finish', defer.resolve);
                    return defer.promise;
                }
            ).then(
                function() {
                    return object_client.complete_multipart_upload(object_path);
                }
            ).then(
                function() {
                    var duration = (Date.now() - start_time) / 1000;
                    var elapsed = duration.toFixed(1) + 'sec';
                    var speed = $rootScope.human_size(file.size / duration) + '/sec';
                    console.log('upload completed', elapsed, speed);
                    nbAlertify.log('upload completed ' + elapsed + ' ' + speed);
                    return load_bucket_objects(bucket);
                }
            ).then(null,
                function(err) {
                    console.error('upload failed', err);
                    nbAlertify.error('upload failed. ' + err.toString());
                }
            );
        }

        function load_buckets() {
            return $q.when(object_client.list_buckets()).then(
                function(res) {
                    $scope.buckets = _.sortBy(res.buckets, 'name');
                    $scope.buckets_by_name = _.indexBy($scope.buckets, 'name');
                    $scope.bucket =
                        $scope.bucket && $scope.buckets_by_name[$scope.bucket.name] ||
                        $scope.buckets[0];
                    return load_bucket_objects($scope.bucket);
                }
            );
        }

        function load_bucket_objects(bucket) {
            if (!bucket) return;

            return $q.when(object_client.list_bucket_objects({
                bucket: bucket.name
            })).then(
                function(res) {
                    console.log('load_bucket_objects', bucket.name, res);
                    bucket.objects = res.objects;
                    _.each(bucket.objects, function(object) {
                        object.bucket = bucket;
                    });
                }
            );
        }

        return $scope;
    }
]);
