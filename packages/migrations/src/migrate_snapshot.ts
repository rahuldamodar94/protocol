#!/usr/bin/env node
import { devConstants, web3Factory } from '@0x/dev-utils';
import { logUtils } from '@0x/utils';
import { Provider } from 'ethereum-types';
import * as fs from 'fs';
import * as _ from 'lodash';
import * as path from 'path';

import { runMigrationsAsync } from './migration';

(async () => {
    let providerConfigs;
    let provider: Provider;
    let txDefaults;
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const packageJsonString = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonString);
    if (_.isUndefined(packageJson.config) || _.isUndefined(packageJson.config.snapshot_name)) {
        throw new Error(`Did not find 'snapshot_name' key in package.json config`);
    }

    providerConfigs = { shouldUseInProcessGanache: true, ganacheDatabasePath: packageJson.config.snapshot_name };
    provider = web3Factory.getRpcProvider(providerConfigs);
    txDefaults = {
        from: devConstants.TESTRPC_FIRST_ADDRESS,
    };
    await runMigrationsAsync(provider, txDefaults);
    process.exit(0);
})().catch(err => {
    logUtils.log(err);
    process.exit(1);
});
