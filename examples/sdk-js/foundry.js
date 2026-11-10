import { createReadStream, statSync } from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Microsoft Foundry through the Axium proxy.
//
// A `foundry` provider is ONE Foundry resource (https://<resource>.services.ai.azure.com)
// that serves two APIs with the same key:
//
//   - /openai/v1    -> OpenAI wire format, for everything that is not Claude
//   - /anthropic/v1 -> Anthropic wire format, only for Claude deployments

// Three differences from openai.js / anthropic.js:
//
//   - `model` is the DEPLOYMENT NAME exactly as it appears in the Foundry
//     portal (the model deployed in Axium must have exactly the same name).
//     No provider/ or publisher prefix: a name that does not exist as a
//     deployment in the resource returns Microsoft's 404 "The API deployment
//     for this resource does not exist", passed through as is (see test 10).
//   - no api-version and no AzureOpenAI client: the Foundry v1 gate does not
//     need it and the proxy speaks the flat OpenAI layout. Plain OpenAI client.
//   - authentication towards the proxy is always `Authorization: Bearer ax_...`.
//     The Anthropic SDK with `apiKey` sends x-api-key, which the proxy does not
//     read, so `authToken` is used instead, which is what sends Bearer.
//
// Towards Foundry the proxy strips the client credential and sets the provider
// one (api-key on the OpenAI gate, x-api-key on the Anthropic gate). The
// anthropic-version / anthropic-beta headers travel unchanged.

const PROXY_APP_ID = 'proxy-app-id';
const API_KEY = 'ax_344-example';

// Deployments of the Foundry resource, named exactly as in the portal.
// GPT_DEPLOYMENT goes through /openai, CLAUDE_DEPLOYMENT through /anthropic.
const GPT_DEPLOYMENT = 'gpt-5-nano';
const CLAUDE_DEPLOYMENT = 'claude-haiku-4-5';

const PROXY = `http://localhost:3000/v1/proxy-apps/${PROXY_APP_ID}`;

// OpenAI gate. The /v1 segment is optional in the proxy; the SDK appends
// /responses, /chat/completions, /models, /files.
const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: `${PROXY}/openai`,
});

// Anthropic gate. authToken -> Authorization: Bearer; apiKey -> x-api-key (does not work).
const anthropic = new Anthropic({
  authToken: API_KEY,
  baseURL: `${PROXY}/anthropic`,
});

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// model tests, called by name: node foundry.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;
// file tests, called by name: node foundry.js file1
const file_test = /^file\d+$/.test(arg) ? arg : null;

// the text blocks of an Anthropic response, concatenated
function text_of(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ===========================================================================
// OpenAI gate (/openai) - GPT deployment
// ===========================================================================

// test 1 - responses api, hello world
if (test_execution === 1) {
  const response = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    input: 'Tell me three names in a row',
  });

  console.log('model:', response.model);
  console.log('usage:', response.usage);
  console.log(response.output_text);
}

// test 2 - structured output
if (test_execution === 2) {
  const response = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    instructions: 'Extract the event information from the user message.',
    input:
      'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
    text: {
      format: {
        type: 'json_schema',
        name: 'calendar_event',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            date: { type: 'string' },
            city: { type: 'string' },
            participants: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['name', 'date', 'city', 'participants'],
          additionalProperties: false,
        },
      },
    },
  });

  const event = JSON.parse(response.output_text);

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}

// test 3 - tool call happy path
if (test_execution === 3) {
  const tools = [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get the current temperature for a given city.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, e.g. Barcelona' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city', 'unit'],
        additionalProperties: false,
      },
    },
  ];

  const input = [
    {
      role: 'user',
      content: 'What is the temperature in Barcelona right now, in celsius?',
    },
  ];

  const first = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    tools,
    input,
  });

  const call = first.output.find((item) => item.type === 'function_call');

  if (!call) {
    console.log('the model did not call the tool:', first.output_text);
    process.exit(1);
  }

  console.log('tool call:', call.name, call.arguments);

  const args = JSON.parse(call.arguments);
  const result = { city: args.city, unit: args.unit, temperature: 21 };

  const second = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    tools,
    input: [
      ...input,
      call,
      {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      },
    ],
  });

  console.log(second.output_text);
}

// test 4 - chat.completions + generation params
if (test_execution === 4) {
  const response = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
    max_completion_tokens: 200,
    reasoning_effort: 'minimal',
    seed: 42,
  });

  const choice = response.choices[0];

  console.log('id:', response.id);
  console.log('object:', response.object);
  console.log('model:', response.model);
  console.log('finish_reason:', choice.finish_reason);
  console.log('usage:', response.usage);
  console.log(choice.message.content);
}

// test 5 - responses stream
if (test_execution === 5) {
  const stream = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    input: 'Tell me three names in a row',
    stream: true,
  });

  let events = 0;
  let usage = null;

  for await (const event of stream) {
    events++;

    if (event.type === 'response.output_text.delta') {
      process.stdout.write(event.delta);
    }
    if (event.type === 'response.completed') {
      usage = event.response.usage;
    }
  }

  console.log('\n\nevents received:', events);
  console.log('usage:', usage);
}

// test 6 - chat.completions stream, WITHOUT stream_options

if (test_execution === 6) {
  const stream = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
    seed: 42,
    max_completion_tokens: 300,
    reasoning_effort: 'minimal',
    stream: true,
  });

  let text = '';
  let index = 0;
  let usage = null;
  let usage_chunk = null;

  for await (const chunk of stream) {
    // every chunk exactly as it arrives, unfiltered and ungrouped
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(chunk, null, 2));

    const delta = chunk.choices[0]?.delta?.content;
    if (delta) text += delta;

    if (chunk.usage) {
      usage = chunk.usage;
      usage_chunk = index - 1;
    }
  }

  console.log('--- accumulated text ---');
  console.log(text);
  console.log('chunks:', index);
  console.log(
    'chunk with usage:',
    usage_chunk ?? '(NONE: the proxy did not inject include_usage)',
  );
  console.log('usage:', usage);
}

// ===========================================================================
// Anthropic gate (/anthropic) - Claude deployment
// ===========================================================================
// Only messages, messages/count_tokens and streaming. On Foundry these are NOT

// test 7 - messages, hello world
if (test_execution === 7) {
  const response = await anthropic.messages.create({
    model: CLAUDE_DEPLOYMENT,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
  });

  if (response.stop_reason === 'refusal') {
    console.error('Request refused:', response.stop_details?.category);
    process.exit(1);
  }

  console.log('model:', response.model);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}

// test 8 - messages stream
// Anthropic has no usage flag: message_start carries input_tokens,

if (test_execution === 8) {
  const stream = anthropic.messages.stream({
    model: CLAUDE_DEPLOYMENT,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
  });

  let events = 0;
  let stop = false;

  for await (const event of stream) {
    events++;

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
    }
    if (event.type === 'message_delta') {
      console.log(
        '\n\nmessage_delta usage:',
        event.usage,
        '| stop_reason:',
        event.delta.stop_reason,
      );
    }
    if (event.type === 'message_stop') stop = true;
  }

  console.log('events received:', events);
  console.log(
    'message_stop:',
    stop ? 'received' : '(MISSING: the proxy swallowed the close event)',
  );
}

// test 9 - count_tokens
// POST /messages/count_tokens: counts the input tokens without generating
// anything. Compared against the input_tokens reported by the real request.
if (test_execution === 9) {
  const params = {
    model: CLAUDE_DEPLOYMENT,
    system: 'Answer in a single line.',
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
  };

  const counted = await anthropic.messages.countTokens(params);
  console.log('count_tokens:', counted);

  const response = await anthropic.messages.create({
    ...params,
    max_tokens: 100,
  });
  console.log('real usage:', response.usage);
  console.log(
    counted.input_tokens === response.usage.input_tokens
      ? 'they match'
      : `they differ by ${response.usage.input_tokens - counted.input_tokens}`,
  );
}

// ===========================================================================
// Wrong gate
// ===========================================================================

// test 10 - Claude deployment through the OpenAI gate
// Foundry serves each deployment only through its own gate. Asking for the

if (test_execution === 10) {
  try {
    const response = await openai.chat.completions.create({
      model: CLAUDE_DEPLOYMENT,
      messages: [{ role: 'user', content: 'Tell me three names in a row' }],
    });

    console.log(
      'unexpected, it answered:',
      response.choices[0].message.content,
    );
  } catch (err) {
    console.log('status:', err.status);
    console.log('error:', JSON.stringify(err.error ?? err.message, null, 2));
  }
}

// --- models api -----------------------------------------------------------
// GET /openai/v1/models on Foundry lists ONLY the OpenAI gate deployments:
// the Claude ones do not show up.

// model1 - list deployments
if (model_test === 'model1') {
  const pager = await openai.models.list();

  let count = 0;

  for await (const m of pager) {
    count++;
    console.log(`${count}. ${m.id}`);
    console.log(
      '   object:',
      m.object,
      '| owned_by:',
      m.owned_by,
      '| created:',
      m.created,
    );
  }

  console.log('total models:', count);
}

// model2 - retrieve a specific deployment
if (model_test === 'model2') {
  const id = process.argv[3] ?? GPT_DEPLOYMENT;

  const model = await openai.models.retrieve(id);

  console.log(model);
}

// --- files api ------------------------------------------------------------
// Only through the OpenAI gate, which accepts the openai and foundry providers.
// These routes carry no model in the body, so the proxy routes them by the
// provider of the proxy-app's DEFAULT model: that model must live in the Foundry
// provider or the upload ends up somewhere else.

const pdf_path = new URL('./sample.pdf', import.meta.url);

// file1 - upload
// If bytes does not match the real size of the PDF, something along the way is
// touching the body.
if (file_test === 'file1') {
  const size = statSync(pdf_path).size;

  const file = await openai.files.create({
    file: createReadStream(pdf_path),
    purpose: 'user_data',
  });

  console.log('id:', file.id);
  console.log('filename:', file.filename);
  console.log(
    'bytes:',
    file.bytes,
    '| on disk:',
    size,
    file.bytes === size ? '(ok)' : '(MISMATCH)',
  );
  console.log('purpose:', file.purpose);
  console.log('\nreusable: node foundry.js file2', file.id);
}

// file2 - retrieve and delete
// Accepts a file_id as argv[3]; if missing, uploads the PDF first.
if (file_test === 'file2') {
  let id = process.argv[3];
  let mine = false;

  if (!id) {
    const uploaded = await openai.files.create({
      file: createReadStream(pdf_path),
      purpose: 'user_data',
    });
    id = uploaded.id;
    mine = true;
    console.log('uploaded for the test:', id);
  }

  const file = await openai.files.retrieve(id);
  console.log(file);

  if (mine) {
    await openai.files.delete(id);
    console.log('deleted:', id);
  }
}
