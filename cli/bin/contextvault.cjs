#!/usr/bin/env node
'use strict';
require('../lib/cli.cjs').main(process.argv.slice(2), process.env).then(code => { process.exitCode = code; }, () => {
  process.stderr.write('{"ok":false,"error":{"code":"CLI_FAILURE","message":"CLI output failed"}}\n');
  process.exitCode = 1;
});
