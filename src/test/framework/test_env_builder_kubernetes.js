/* Copyright (C) 2016 NooBaa */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { KubernetesFunctions, IS_IN_POD } = require('../../deploy/kubernetes_functions');
const argv = require('minimist')(process.argv);
const server_functions = require('../utils/server_functions');
const agent_functions = require('../utils/agent_functions');
const promise_utils = require('../../util/promise_utils');
const P = require('../../util/promise');
const Semaphore = require('../../util/semaphore');

const dbg = require('../../util/debug_module')(__filename);
dbg.set_process_name('test_env_builder_k8s');


const {
    context,
    output_dir = os.tmpdir(),
    image,
    noobaa_core_yaml = "src/deploy/NVA_build/noobaa_core.yaml",
    tests_list,
    single_test,
    exec,
    node_ip,
    clean: clean_single_test,
    debug,
} = argv;

if (debug) {
    dbg.set_level(3, 'core');
} else {
    dbg.set_level(-1, 'core');
}


const deleted_namespaces = [];

function print_usage() {
    console.log(`
    Usage:  node ${process.argv[1]} [options]
      --help                    -   Show this usage
      --image                   -   Set the image to use
      --namespace_prefix        -   Prefix for created namespaces
      --clean                   -   Delete new namespace if used namespace_prefix
      --env                     -   pass environment variable to the test env containers. more than one can be passed e.g: --env ENV1=one --env ENV2=two
      --context                 -   The name of the kubeconfig context to use (default to current context)
      --node_ip                 -   Pass a node ip to access pods using nodePort
      --noobaa_core_yaml        -   Set the NooBaa core yaml
      --num_agents              -   Change the number of agents from the agent yaml default 
      --agent_cpu               -   Amount of cpu to request for agent pods
      --agent_mem               -   Amount of memory to request for agent pods
      --server_cpu              -   Amount of cpu to request for server pod
      --server_mem              -   Amount of memory to request for server pod
      --pv                      -   Use persistent volumes for deployed images. default is false
      --pull_always             -   Change image pull policy to always (not recommended but required if overriding an image tag with a different version)
      --single_test             -   Path to a single node.js test to run against the created environment
      --exec                    -   Command to run on the created server pod. if single_test is provided the command will run before the test
      --tests_list              -   Path to a js file containing tests list
      --concurrency             -   Maximum number of pods to run in parallel (server and agents). default is 10
      --output_dir              -   Path to store test output
      --debug                   -   run in debug mode
    `);
}


/**
 * returns array of env vars passed in argv, in the format [{name, value}]
 */
function get_env_vars() {
    // if env is not an array make it an array
    if (argv.env) {
        const envs = Array.isArray(argv.env) ? argv.env : [argv.env];
        return envs.map(env => {
            const [name, value] = env.split('=');
            if (!name || !value) {
                throw new Error(`failed to parse env vars. expecting format --env NAME=VALUE`);
            }
            return { name, value };
        });
    }
}


async function build_env(kf, params) {
    const {
        server_cpu,
        server_mem,
        agent_cpu,
        agent_mem,
        pv,
        pull_always,
        num_agents = 0,
    } = params;
    try {
        console.log(`deploying noobaa server image ${image} in namespace ${kf.namespace}`);
        const envs = get_env_vars() || [];
        envs.push({ name: 'CREATE_SYS_NAME', value: 'demo' });
        envs.push({ name: 'CREATE_SYS_EMAIL', value: 'demo@noobaa.com' });
        envs.push({ name: 'CREATE_SYS_PASSWD', value: 'DeMo1' });
        const server_details = await kf.deploy_server({
            image,
            server_yaml: noobaa_core_yaml,
            envs,
            cpu: server_cpu,
            mem: server_mem,
            pv,
            pull_always
        });
        console.log(`noobaa server deployed:`);
        console.log(`\tmanagement address: ${server_details.services.mgmt.address} ports:`, server_details.services.mgmt.ports);
        console.log(`\ts3 server address : ${server_details.services.s3.address} ports:`, server_details.services.s3.ports);

        // TODO: rewrite server_functions and agent_functions used here in a more clean and generic way.
        // create system 
        const { address: mgmt_address, ports: mgmt_ports } = server_details.services.mgmt;
        const { address: s3_address, ports: s3_ports } = server_details.services.s3;
        console.log('waiting for system to be ready');
        await server_functions.wait_for_system_ready(mgmt_address, mgmt_ports['mgmt-https'], 'wss');

        const pool_name = 'first.pool';
        console.log(`creating new pool '${pool_name}'`);
        await server_functions.create_pool(mgmt_address, mgmt_ports['mgmt-https'], pool_name);

        if (num_agents) {
            console.log(`deploying ${num_agents} agents in ${pool_name}`);
            const agents_yaml = await agent_functions.get_agents_yaml(mgmt_address, mgmt_ports['mgmt-https'], pool_name, IS_IN_POD ? 'INTERNAL' : 'EXTERNAL');
            const agents_yaml_path = path.join(output_dir, 'agents.yaml');
            await fs.writeFileSync(agents_yaml_path, agents_yaml);
            await kf.deploy_agents({
                image,
                num_agents,
                agents_yaml: agents_yaml_path,
                envs: get_env_vars(),
                cpu: agent_cpu,
                mem: agent_mem,
                pv,
                pull_always
            });
            console.log(`waiting for ${num_agents} agents to be in optimal state`);
            await wait_for_agents_optimal(mgmt_address, mgmt_ports['mgmt-https'], num_agents);
            console.log(`all agents are in optimal state`);
        } else {
            console.log('no agents are deployed for this env');
        }

        // return services access information to pass to test
        return {
            mgmt_ip: mgmt_address,
            mgmt_port: mgmt_ports.mgmt,
            mgmt_port_https: mgmt_ports['mgmt-https'],
            s3_ip: s3_address,
            s3_port: s3_ports.s3,
            s3_port_https: s3_ports['s3-https'],
            pod_name: server_details.pod_name,
            kf
        };
    } catch (err) {
        console.error('failed building test environment', err);
        throw err;
    }

}

async function run_single_test_env(params) {
    const {
        namespace,
        command,
        test,
        name,
        clean,
        await_clean,
    } = params;

    const test_name = name || path.basename(test);
    let test_failed = false;

    const kf = new KubernetesFunctions({
        context,
        output_dir,
        node_ip,
        namespace,
    });
    try {
        await kf.init();
        const test_context = await build_env(kf, params);
        const {
            mgmt_ip,
            mgmt_port,
            mgmt_port_https,
            s3_ip,
            s3_port,
            s3_port_https,
            pod_name
        } = test_context;


        if (command) {
            try {
                console.log(`executing command on server pod: ${command}`);
                await kf.kubectl(`exec ${pod_name} -- ${command}`);
            } catch (err) {
                console.error(`failed running command on pod ${pod_name}. command: ${command}. error:`, err);
                test_failed = true;
            }
        }
        if (test && !test_failed) {
            const log_file = path.join(output_dir, `${test_name}.log`);
            console.log(`running test ${test_name}. test log: ${log_file}`);
            //pass as args all test_env args with addition of services info 
            const args = [...process.argv, '--mgmt_ip', mgmt_ip,
                '--mgmt_port', mgmt_port,
                '--mgmt_port_https', mgmt_port_https,
                '--s3_ip', s3_ip,
                '--s3_port', s3_port,
                '--s3_port_https', s3_port_https,
                '--log_file', log_file
            ];
            await promise_utils.fork(test, args);
            console.log(`test ${test_name} passed`);
        }
    } catch (err) {
        test_failed = true;
        console.log(`test ${test_name} failed. ${err}`);
    }

    if (clean || clean_single_test) {
        console.log('cleaning test environment');
        try {
            // for now by default delete namespaces in background. if running tests concurrently we might want to await
            if (await_clean) {
                await kf.delete_namespace();
            } else {
                deleted_namespaces.push(kf.delete_namespace());
            }
        } catch (err) {
            console.error(`failed to delete namespace ${namespace}`);
        }
    }

    if (test_failed) {
        throw new Error(`test failure`);
    }

}

async function run_multiple_test_envs(params) {
    const {
        tests_list: tests_list_file,
        concurrency,
        namespace_prefix
    } = params;
    let tests;

    try {
        tests = require(tests_list_file); // eslint-disable-line global-require
    } catch (err) {
        console.error(`failed to load tests list from ${tests_list_file}`);
        throw err;
    }

    try {
        if (concurrency) {
            await run_test_concurrently(concurrency, tests, namespace_prefix, params);
        } else {
            await run_test_serially(tests, namespace_prefix, params);
        }
    } catch (err) {
        console.error(`something went wrong when running test list ${tests_list_file}`, err.message);
        throw err;
    }

    console.log('============================== Tests report: ==============================');
    for (const test of tests) {
        console.log(`${test.passed ? '===PASSED===' : '===FAILED==='} ${test.name}`);
    }
    console.log('===========================================================================');


    const any_failure = tests.some(test => !test.passed);
    if (any_failure) {
        throw new Error('Test run failed');
    }




}

async function run_test_concurrently(concurrency, tests, namespace_prefix, params) {
    const sem = new Semaphore(concurrency);
    // run in parallel with limit on the number of pods (num_agents + 1)
    await P.all(tests.map(async test => {
        const num_pods = (test.num_agents || 0) + 1;
        await sem.surround_count(num_pods, () => run_test(namespace_prefix, test, params));
    }));
}

async function run_test_serially(tests, namespace_prefix, params) {
    for (const test of tests) {
        await run_test(namespace_prefix, test, params);
    }
}

async function run_test(namespace_prefix, test, params) {
    const namespace = `${namespace_prefix}-${test.name}-${Date.now()}`;
    console.log(`=============== running test ${test.name} in namespace ${namespace} ===============`);
    // when running multiple envs force clean at the end of each run
    const test_params = { ...params, ...test, namespace, clean: true };
    try {
        await run_single_test_env(test_params);
        test.passed = true;
    } catch (err) {
        test.passed = false;
    }
}

async function main() {
    // let exit_code = 0;
    if (argv.help) {
        print_usage();
        process.exit(0);
    }


    let exit_code = 0;
    try {
        if (tests_list) {
            // run multiple tests
            await run_multiple_test_envs(argv);
        } else if (single_test || exec) {
            // build env and run a single test
            await run_single_test_env({ ...argv, command: exec, test: single_test, namespace: argv.namespace_prefix });
        } else {
            // just build env
            const namespace = argv.namespace_prefix;
            const kf = new KubernetesFunctions({
                context,
                output_dir,
                node_ip,
                namespace,
            });
            await kf.init();
            await build_env(kf, { ...argv, namespace });
        }

        // wait for all namespaces to be deleted
        await P.all(deleted_namespaces);
    } catch (err) {
        console.error('test_env_builder failed with error:', err);
        exit_code = 1;
    }

    if (exit_code === 0) {
        console.log('Test run completed successfully');
    } else {
        console.log('Test run failed!!');
    }

    process.exit(exit_code);



}

async function wait_for_agents_optimal(server_ip, server_port, expected_num_optimal, timeout) {
    // default timeout of 5 minutes
    timeout = timeout || 5 * 60000;
    await P.resolve()
        .then(async () => {
            while (await server_functions.get_num_optimal_agents(server_ip, server_port) !== expected_num_optimal) {
                await P.delay(5000);
            }
        })
        .timeout(timeout);

}

if (require.main === module) {
    main();
}
