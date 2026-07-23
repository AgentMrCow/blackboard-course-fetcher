#!/usr/bin/env node

const { runFetchAllCli } = require("../src/composition/fetch-all-runtime");

if (require.main === module) {
  runFetchAllCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
