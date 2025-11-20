#!/usr/bin/env node

import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import Getopt from "node-getopt";

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
    ['v', 'verbosity=[EFFORT]', 'Verbosity: 0, 1, 2', '0'],
    ['', 'id=[ID]', 'Response ID to retrieve'],
    ['', 'todo', 'Complete first TODO from stdin'],
    ['', 'resume', 'Resume last created response'],
    ['', 'web', 'Allow web search tool.'],
    ['', 'patch', 'Allow patch tool.'],
    ['i', 'instructions', 'Instructions', '']
])

const args = getopt.parse(process.argv.slice(2));

let prompt = args.options.instructions || '';
let files = new Map();
let contentRows = [];


const stdin = await new Promise((resolve) => {
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


for (const row of args.argv) {
    if (row === '-') {
        if (stdin.trim().length > 0) {
            contentRows.push({
                type: "input_text",
                text: stdin,
            });
        }
        continue;
    }

    if (row.match(/^https?:\/\//)) {
        if (isImage(row)) {
            contentRows.push({
                type: "input_image",
                image_url: row,
                detail: 'high',
            });
        } else {
            const mime = getMimeType(row);

            switch (mime) {
                case 'application/pdf':
                    contentRows.push({
                        type: "input_file",
                        file_url: row,
                    });
                    break;

                default:
                    contentRows.push({
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
            contentRows.push({
                type: "input_image",
                image_url: toDataUrl(row, content),
                detail: 'high',
            });
        } else {
            const mime = getMimeType(row);

            switch (mime) {
                case 'application/pdf':
                    contentRows.push({
                        type: "input_file",
                        filename: path.basename(row),
                        file_data: toDataUrl(row, content),
                    });
                    break;

                default:
                    contentRows.push({
                        type: "input_text",
                        text: `Filename: ${row}\n\n` + content.toString('utf-8'),
                    });
                    break;
            }
        }
        continue;
    }

    contentRows.push({
        type: "input_text",
        text: row,
    });
}


if (args.options.todo) {
    prompt = 'Complete the first TODO in the input text. Only output the text that replaces the TODO, do not output any other text.';
}


if (args.options.help) {
    getopt.showHelp();
    process.exit(1);
}


const inputTokenCostPer1M = 1.25;
const outputTokenCostPer1M = 10.0;


if (args.options.resume) {
    try {
        const lastResponseId = await fs.readFile("/tmp/ai-last_response_id.txt", "utf-8");
        args.options.id = lastResponseId.trim();
    } catch (e) {
        process.stderr.write(red("No last response ID found to resume.\n"));
        process.exit(1);
    }
}


if (args.options.id) {
    const filePath = `/tmp/ai-${args.options.id}.json`;
    let response = await fs.readFile(filePath, "utf-8").catch(() => null);
    if (response) {
        response = JSON.parse(response);
    } else {
        process.stderr.write(gray('Retrieving existing response...\n'));
        response = await openai.responses.retrieve(args.options.id);
        response = await waitForCompletion(response);
        await fs.writeFile(filePath, JSON.stringify(response));
    }
    outputResponse(response);
    process.exit(0);
}


if (contentRows.length == 0) {
    process.stderr.write(red("No input provided.\n\n"));
    getopt.showHelp();
    process.exit(1);
}

const request = {
    model: args.options.model,
    background: true
}

request.input = [];

if (contentRows.length > 0) {
    request.input.push({
        type: "message",
        role: "user",
        content: contentRows,
    });
}


request.instructions = prompt;


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
        request.text = {};
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

fs.writeFile("/tmp/ai-last_response_id.txt", response.id);

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

    return response;
}


function outputResponse(response) {
    //console.log(response);
    for (const out of (response.output || [])) {
        if (out.type === 'apply_patch_call') {
            outputPatch(out.operation);
        }
    }
    process.stdout.write(response.output_text);
    process.stdout.write("\n");
}


function outputPatch(operation) {
    // Normalize path (strip leading ./ if present)
    const filePath = operation.path.replace(/^[.][/\\]/, "");

    // Body is assumed to already be in unified diff hunk format
    if (operation.diff) {
        if (!operation.diff.endsWith("\n")) {
            process.stdout.write(operation.diff + "\n");
        } else {
            process.stdout.write(operation.diff);
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
