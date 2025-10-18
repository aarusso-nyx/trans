#!/usr/bin/env node
// Thin launcher for the ESM CLI entry.
const { resolve } = require('path');
const { pathToFileURL } = require('url');

const entry = pathToFileURL(resolve(__dirname, '..', 'index.mjs')).href;
import(entry);

