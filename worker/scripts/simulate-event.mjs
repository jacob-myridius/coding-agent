import { readFile } from "node:fs/promises";
import { processWorkItemEventBody } from "../processWorkItem.js";

const filePath = process.argv[2] || "../../sample-workitem-created.json";
const payloadRaw = await readFile(new URL(filePath, import.meta.url), "utf8");
const payload = JSON.parse(payloadRaw);

const result = await processWorkItemEventBody(payload);
console.log(JSON.stringify(result, null, 2));


