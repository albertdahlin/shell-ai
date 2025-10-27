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
    ['m', 'model=[MODEL]', 'Model to use', 'gpt-5'],
    ['r', 'reasoning=[EFFORT]', 'Reason effort: 0, 1, 2, 3', '0'],
    ['', 'id=[ID]', 'Response ID to retrieve'],
    ['', 'todo', 'Complete first TODO from stdin'],
    ['', 'resume', 'Resume last created response'],
    ['', 'web', 'Allow web search tool.'],
    ['', 'prompt', 'PROMPT']
])

const args = getopt.parse(process.argv.slice(2));

let prompt = args.argv[0];

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

if (!prompt && !stdin) {
    process.stderr.write(red("No prompt provided.\n"));
    getopt.showHelp();
    process.exit(1);
}

const request = {
    model: args.options.model,
    background: true
}

if (stdin) {
    request.input = stdin;
    request.instructions = prompt;
} else {
    request.input = prompt;
}

if (args.options.model.startsWith("gpt-5")) {
    request.reasoning = {};
    switch (args.options.reasoning) {
        case '0':
            request.reasoning.effort = "minimal";
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
            process.stderr.write(red("Invalid reasoning effort. Use 0, 1, 2, or 3.\n"));
            process.exit(1);
    }
}

if (args.options.web) {
    request.tools = [{
        type: "web_search",
    }];
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

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const inputCost = (inputTokens / 1_000_000) * inputTokenCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * outputTokenCostPer1M;
    const totalCost = inputCost + outputCost;
    process.stderr.write(`${gray('Cost:')} ${white(`$${totalCost.toFixed(6)} (Input: ${inputTokens} tokens, Output: ${outputTokens} tokens)`)}\n`);

    return response;
}

function outputResponse(response) {
    process.stdout.write(response.output_text);
    process.stdout.write("\n");
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
