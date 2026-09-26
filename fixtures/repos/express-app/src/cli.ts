#!/usr/bin/env node
import { processData } from "./services/data.js";

const input = process.argv[2] || "";
const result = processData(input);
console.log("CLI output:", result);
