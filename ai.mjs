#!/usr/bin/env node

import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import Getopt from "node-getopt";

const inputTokenCostPer1M = 1.25;
const outputTokenCostPer1M = 10.0;
const tmpDir = "/tmp/ai-cli";

const token = await fs.readFile(
    path.join(process.env.HOME, ".config/openai-private.token"), "utf-8"
);

const openai = new OpenAI({
    apiKey: token.trim()
});

const getopt = new Getopt([
    ['h', 'help', 'Show this help'],
    ['m', 'model=[MODEL]', 'Model to use', 'gpt-5.1'],
    ['r', 'reasoning=[EFFORT]', 'Reason effort: 0, 1, 2, 3', '0'],
    ['v', 'verbosity=[VERBOSITY]', 'Verbosity: 0, 1, 2', '0'],
    ['l', 'list', 'List history'],
    ['', 'id=[ID]', 'Response ID to retrieve'],
    ['', 'todo', 'Complete first TODO from stdin'],
    ['', 'resume', 'Resume using last created response'],
    ['', 'rm=[ID]', 'Remove response from history'],
    ['', 'web', 'Allow web search tool.'],
    ['', 'patch', 'Allow patch tool.'],
    ['i', 'instructions', 'Instructions', ''],
    ['s', 'schema=[SCHEMA]', 'JSON Schema for structured output', ''],
    ['', 'new-schema', 'Print a schema template']
])

const args = getopt.parse(process.argv.slice(2));

if (args.options.list) {
    await listHistory();
    process.exit(0);
}


let prompt = args.options.instructions || '';

if (args.options['new-schema']) {
    const schemaTemplate = newSchemaTemplate();
    process.stdout.write(JSON.stringify(schemaTemplate, null, 2) + "\n");
    process.exit(0);
}

const stdin = await readStdin();
const inputRows = await parseInputRows(args);


let schema = null;

if (args.options.schema) {
    const schemaContent = await fs.readFile(args.options.schema, "utf-8").catch(() => null);
    if (schemaContent) {
        try {
            schema = JSON.parse(schemaContent);
        } catch (e) {
            process.stderr.write(red("Failed to parse JSON schema.\n"));
            process.exit(1);
        }
    } else {
        process.stderr.write(red("Failed to read schema file.\n"));
        process.exit(1);
    }
}


if (args.options.todo) {
    prompt = 'Complete the first TODO in the input text. Only output the text that replaces the TODO, do not output any other text.';
}


if (args.options.help) {
    getopt.showHelp();
    process.exit(1);
}

if (args.options.rm) {
    const idToRemove = args.options.rm;
    const response = await loadResponse(idToRemove);
    if (!response) {
        process.stderr.write(red(`Response ID ${idToRemove} not found in history.\n`));
        process.exit(1);
    }
    await remove(response.id);
    process.stdout.write(green(`Removed response ID ${idToRemove} from history.\n`));
    process.exit(0);
}

if (args.options.resume) {
    try {
        const lastResponseId = await loadLastId();
        args.options.id = lastResponseId.trim();
    } catch (e) {
        process.stderr.write(red("No last response ID found to resume.\n"));
        process.exit(1);
    }
}

let previousResponse = null;

if (args.options.id) {
    previousResponse = await loadResponse(args.options.id);
    if (!previousResponse) {
        process.stderr.write(gray('Retrieving existing response...\n'));
        previousResponse = await openai.responses.retrieve(args.options.id);
        previousResponse = await waitForCompletion(response);
    }
}


if (inputRows.length == 0) {
    if (previousResponse) {
        outputResponse(previousResponse);
        process.exit(0);
    } else {
        process.stderr.write(red("No input provided.\n\n"));
        getopt.showHelp();
        process.exit(1);
    }
}

const request = {
    model: args.options.model,
    background: true
}

if (previousResponse) {
    request.previous_response_id = previousResponse.id;
}

request.input = [];

if (inputRows.length > 0) {
    request.input.push({
        type: "message",
        role: "user",
        content: inputRows,
    });
}


request.instructions = prompt;

request.text = {};

if (args.options.model.startsWith("gpt-5")) {
    request.reasoning = {};

    switch (args.options.reasoning) {
        case '0':
            if (args.options.model === "gpt-5.1") {
                request.reasoning.effort = "none";
            } else {
                request.reasoning.effort = "minimal";
            }
            break;

        case '1':
            request.reasoning.effort = "low";
            break;

        case '2':
            request.reasoning.effort = "medium";
            break;

        case '3':
            request.reasoning.effort = "high";
            break;

        default:
            process.stderr.write(red("Invalid reasoning effort. Use 0, 1, 2, 3, or 4.\n"));
            process.exit(1);
    }

    if (args.options.verbosity) {
        switch (args.options.verbosity) {
            case '0':
                request.text.verbosity = 'low';
                break;

            case '1':
                request.text.verbosity = 'medium';
                break;

            case '2':
                request.text.verbosity = 'high';
                break;

            default:
                process.stderr.write(red("Invalid verbosity level. Use 0, 1, or 2.\n"));
                process.exit(1);
        }
    }
}

if (schema) {
    schema.type = 'json_schema';
    request.text.format = schema;
}

request.tools = [];


if (args.options.web) {
    request.tools.push({
        type: "web_search",
    });
}

if (args.options.patch) {
    request.tools.push({
        type: "apply_patch",
    });
}


process.stderr.write(gray('Creating new response...\n'));

let response = await openai.responses.create(request);

await saveLastId(response.id);
await saveRequest(response.id, request);

response =  await waitForCompletion(response);

outputResponse(response);


async function waitForCompletion(response) {
    process.stderr.write(`${gray('Model:')} ${white(response.model)}\n`);
    process.stderr.write(`${gray('Response ID:')} ${white(response.id)}\n`);
    const createdAt = new Date(response.created_at * 1000).toLocaleString('sv-SE');
    process.stderr.write(`${gray('Created At:')} ${white(createdAt)}\n`);
    process.stderr.write('\n');
    let dt = 0;
    while (response.status === "queued" || response.status === "in_progress") {
        process.stderr.write(moveUp(1));
        process.stderr.write(clearLine());
        process.stderr.write(`${gray('Processing')} ${green(spinnerUnicode(dt))}`);
        process.stderr.write('\n');
        await new Promise(resolve => setTimeout(resolve, 500)); // wait 2 seconds
        dt += 1;

        if (dt % 4 === 0) {
            response = await openai.responses.retrieve(response.id);
        }
    }

    const tools = (response.tools || []).map(tool => tool.type).join(", ") || "None";
    process.stderr.write(moveUp(1));
    process.stderr.write(clearLine());
    process.stderr.write(gray(`\rProcessing completed.\n`));
    process.stderr.write(`${gray('Tools used:')} ${white(tools)}\n`);

    if (response.error) {
        process.stderr.write(red(`Error: ${response.error.message}\n`));
        process.exit(1);
    }

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const inputCost = (inputTokens / 1_000_000) * inputTokenCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * outputTokenCostPer1M;
    const totalCost = inputCost + outputCost;
    process.stderr.write(`${gray('Cost:')} ${white(`$${totalCost.toFixed(6)} (Input: ${inputTokens} tokens, Output: ${outputTokens} tokens)`)}\n`);

    await saveResponse(response);

    return response;
}


function outputResponse(response) {
    for (const out of (response.output || [])) {
        if (out.type === 'apply_patch_call') {
            outputPatch(out.operation);
        }
    }

    process.stdout.write(response.output_text);
    process.stdout.write("\n");
}


function outputPatch(operation) {
    if (operation.type === 'update_file') {
        process.stdout.write(cyan(`\n--- Update: ${operation.path} ---\n`));
        outputDiff(operation.diff);
        return;
    }

    if (operation.type === 'create_file') {
        process.stdout.write(cyan(`Create file: ${operation.path}\n`));
        outputDiff(operation.diff);
        return;
    }

    if (operation.type === 'delete_file') {
        process.stdout.write(red(`- Deleted file: ${operation.filename}\n`));
        return;
    }
    console.log(operation);
}

function outputDiff(diff) {
    const lines = diff.split('\n');
    for (const line of lines) {
        if (line.startsWith('+')) {
            process.stdout.write(green(line.substring(1)) + "\n");
        } else if (line.startsWith('-')) {
            process.stdout.write(red(line.substring(1)) + "\n");
        } else if (line.startsWith('@')) {
            process.stdout.write(cyan(line) + "\n");
        } else {
            process.stdout.write(gray(line) + "\n");
        }
    }
}

function spinnerUnicode(dt) {
    const spinners = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    return spinners[dt % spinners.length];
}


function termColor(text, colorCode) {
    return `\x1b[${colorCode}m${text}\x1b[0m`;
}


function red(text) {
    return termColor(text, 31);
}
function green(text) {
    return termColor(text, 32);
}
function yellow(text) {
    return termColor(text, 33);
}
function blue(text) {
    return termColor(text, 34);
}
function magenta(text) {
    return termColor(text, 35);
}
function cyan(text) {
    return termColor(text, 36);
}
function white(text) {
    return termColor(text, 37);
}
function gray(text) {
    return termColor(text, 90);
}


function moveUp(lines) {
    return (`\x1b[${lines}A`);
}


function clearLine() {
    return (`\x1b[2K`);
}


function isImage(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeType = getMimeType(filename);
    return mimeType.startsWith('image/');
}


function toDataUrl(filename, buffer) {
    const ext = path.extname(filename).toLowerCase();
    let mimeType = getMimeType(filename);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
}


function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.png':
            return 'image/png';

        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';

        case '.gif':
            return 'image/gif';

        case '.bmp':
            return 'image/bmp';

        case '.webp':
            return 'image/webp';

        case '.tiff':
        case '.tif':
            return 'image/tiff';

        case '.svg':
            return 'image/svg+xml';


        case '.json':
            return 'application/json';

        case '.pdf':
            return 'application/pdf';

        // Text files

        case '.js':
            return 'text/javascript';

        case '.css':
            return 'text/css';

        case '.c':
        case '.cpp':
        case '.h':
        case '.hpp':
            return 'text/x-c';

        case '.txt':
            return 'text/plain';

        case '.html':
        case '.htm':
            return 'text/html';

        case '.md':
            return 'text/markdown';

        case '.php':
            return 'text/x-php';

        case '.py':
            return 'text/x-python';

        case '.sh':
            return 'application/x-sh';

        default:
            return 'application/octet-stream';
    }
}

function newSchemaTemplate() {
    const schemaTemplate = {
        name: "ExampleSchema",
        strict: true,
        schema: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "The title of the item",
                },
                tree: {
                    type: "array",
                    items: { "$ref": "#/$defs/element" },
                },
            },
            required: ["title", "tree" ],
            additionalProperties: false
        },
    };
    schemaTemplate.schema['$defs'] = {
        element: {
            anyOf: [
                {
                    type: "object",
                    properties: {
                        title: {
                            type: "string",
                            description: "The title of the node",
                        },
                        type: {
                            type: "string",
                            enum: ["element"],
                        },
                        children: {
                            type: "array",
                            items: { "$ref": "#/$defs/element" },
                            description: "Child nodes",
                        }
                    },
                    required: ["title", "type", "children"],
                    additionalProperties: false
                },
                {
                    type: "object",
                    properties: {
                        content: {
                            type: "string",
                            description: "The content of the leaf node",
                        },
                        type: {
                            type: "string",
                            enum: ["leaf"],
                        }
                    },
                    required: ["content", "type"],
                    additionalProperties: false
                }
            ]
        }
    };
    return schemaTemplate;
}

async function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        if (process.stdin.isTTY) {
            resolve('');
            return;
        }
        process.stdin.on('data', chunk => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
    });
}

async function save(name, content) {
    await fs.mkdir(tmpDir, { recursive: true });
    return fs.writeFile(path.join(tmpDir, name), content, 'utf-8');
}

async function load(name) {
    return fs.readFile(path.join(tmpDir, name), 'utf-8').catch(() => null);
}

async function remove(id) {
    await fs.unlink(path.join(tmpDir, `${id}.json`)).catch(() => null);
    await fs.unlink(path.join(tmpDir, `req_${id}.json`)).catch(() => null);
}

async function loadLastId() {
    return load("last_response_id.txt");
}

async function saveLastId(id) {
    return save("last_response_id.txt", id);
}

async function saveRequest(id, request) {
    return save(`req_${id}.json`, JSON.stringify(request));
}

async function loadRequest(id) {
    const request = await load(`req_${id}.json`);
    if (!request) {
        return null;
    }

    return JSON.parse(request);
}

async function loadResponse(id) {
    if (id.length < 12) {
        const allIds = await listAllResponseIds();
        const fullId = idFromFile(id, allIds);
        if (!fullId) {
            return null;
        }
        id = fullId;
    }
    const response = await load(`${id}.json`);
    if (!response) {
        return null;
    }

    return JSON.parse(response);
}

async function saveResponse(response) {
    return save(`${response.id}.json`, JSON.stringify(response));
}

async function parseInputRows(args) {
    const inputRows = [];
    for (const row of args.argv) {
        if (row === '-') {
            if (stdin.trim().length > 0) {
                inputRows.push({
                    type: "input_text",
                    text: stdin,
                });
            }
            continue;
        }

        if (row.match(/^https?:\/\//)) {
            if (isImage(row)) {
                inputRows.push({
                    type: "input_image",
                    image_url: row,
                    detail: 'high',
                });
            } else {
                const mime = getMimeType(row);

                switch (mime) {
                    case 'application/pdf':
                        inputRows.push({
                            type: "input_file",
                            file_url: row,
                        });
                        break;

                    default:
                        inputRows.push({
                            type: "input_text",
                            text: `URL: ${row}`,
                        });
                        break;
                }
            }
            continue;
        }

        const exists = await fs.stat(row).catch(() => null);

        if (exists && exists.isFile()) {
            const content = await fs.readFile(row);

            if (isImage(row)) {
                inputRows.push({
                    type: "input_image",
                    image_url: toDataUrl(row, content),
                    detail: 'high',
                });
            } else {
                const mime = getMimeType(row);

                switch (mime) {
                    case 'application/pdf':
                        inputRows.push({
                            type: "input_file",
                            filename: path.basename(row),
                            file_data: toDataUrl(row, content),
                        });
                        break;

                    default:
                        inputRows.push({
                            type: "input_text",
                            text: `Filename: ${row}\n\n` + content.toString('utf-8'),
                        });
                        break;
                }
            }
            continue;
        }

        inputRows.push({
            type: "input_text",
            text: row,
        });
    }

    return inputRows;
}

function idFromFile(shortId, ids) {
    const matches = ids
        .filter(id => {
            return id.endsWith(shortId);
        });

    if (matches.length > 1) {
        throw new Error(`Ambiguous short ID: ${shortId}`);
    }

    if (matches.length === 1) {
        return matches[0];
    }

    return null;
}

async function listAllResponseIds() {
    await fs.mkdir(tmpDir, { recursive: true });
    const files = await fs.readdir(tmpDir);
    const responseIds = files
        .filter(f => f.startsWith('resp_') && f.endsWith('.json'))
        .map(f => path.basename(f, '.json'));

    return responseIds;
}

async function listHistory() {
    const responseIds = await listAllResponseIds();

    if (responseIds.length === 0) {
        process.stdout.write("No history found.\n");
        return;
    }

    const responses = [];
    for (const responseId of responseIds) {
        const response = await loadResponse(responseId);
        if (!response) {
            continue;
        }

        responses.push(response);
    }

    responses.sort((a, b) => b.created_at - a.created_at);

    const responseById = new Map();

    for (const response of responses) {
        responseById.set(response.id, response);
    }

    const conversationThreads = [];

    const visited = new Set();

    for (const response of responses) {
        if (visited.has(response.id)) {
            continue;
        }

        const thread = [];
        let currentResponse = response;

        while (currentResponse) {
            thread.unshift(currentResponse);
            visited.add(currentResponse.id);
            if (currentResponse.previous_response_id) {
                currentResponse = responseById.get(currentResponse.previous_response_id);
            } else {
                currentResponse = null;
            }
        }

        conversationThreads.push(thread);
    }

    for (const thread of conversationThreads) {
        for (const [index, response] of thread.entries()) {
            const shortId = response.id.slice(-8);
            const createdAt = new Date(response.created_at * 1000).toLocaleString('sv-SE');

            const request = await loadRequest(response.id);

            const inputSummary = request.input?.map(inp => {
                if (inp.type === 'message') {
                    const texts = inp.content.filter(c => c.type === 'input_text').map(c => c.text);
                    return texts.join(' | ');
                }
                return inp.type;
            }).join(' || ');

            const outputSummary = response.output.map(out => {
                if (out.type === 'message') {
                    const texts = out.content.filter(c => c.type === 'output_text').map(c => c.text);
                    return texts.join(' | ');
                }
                return out.type;
            }).join(' || ');

            const firstOutputLine = outputSummary.split('\n')[0];

            let indent = '';
            if (index > 0) {
                indent = '  ';
            }
            process.stdout.write(`${indent}${yellow(shortId)} ${gray(createdAt)}\n`);
            process.stdout.write(`${indent}  ${green(inputSummary)}\n`);
            process.stdout.write(`${indent}  > ${firstOutputLine}\n`);
            //process.stdout.write(`  ${gray('Output:')} ${outputSummary}\n`);
            //process.stdout.write('\n');
        }
    }
}
