'use strict';

/**
 *
 * REDIRECTOR API
 *
 */
module.exports = {

    name: 'redirector_api',

    methods: {

        redirect: {
            method: 'POST',
            params: {
                $ref: '/node_api/definitions/redirect_params'
            },
            reply: {
                $ref: '/node_api/definitions/redirect_reply'
            },
            auth: {
                system: false
            }
        },

        register_agent: {
            method: 'POST',
            params: {
                $ref: '/redirector_api/definitions/basic_registration_info'
            },
            auth: {
                system: false
            }
        },

        unregister_agent: {
            method: 'POST',
            params: {
                $ref: '/redirector_api/definitions/basic_registration_info'
            },
            auth: {
                system: false
            }
        },

        resync_agents: {
            method: 'POST',
            params: {
                type: 'object',
                properties: {
                    timestamp: {
                        type: 'integer',
                        format: 'idate',
                    },
                    agents: {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                    },
                },
            },
            auth: {
                system: false
            }
        },

        print_registered_agents: {
            method: 'GET',
            reply: {
                type: 'string',
            },
            auth: {
                system: false
            }
        }
    },

    definitions: {

        basic_registration_info: {
            type: 'object',
            required: ['peer_id'],
            properties: {
                peer_id: {
                    type: 'string',
                },
            }
        },

        redirect_params: {
            type: 'object',
            required: ['target', 'method_api', 'method_name'],
            properties: {
                target: {
                    type: 'string'
                },
                method_api: {
                    type: 'string'
                },
                method_name: {
                    type: 'string'
                },
                request_params: {
                    type: 'object',
                    additionalProperties: true,
                },
            },
        },

        redirect_reply: {
            type: 'object',
            additionalProperties: true,
        },
    }
};
