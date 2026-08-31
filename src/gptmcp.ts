#!/usr/bin/env node
import { main } from "./cli/main.js";

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
