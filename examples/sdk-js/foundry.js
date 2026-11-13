import { createReadStream, readFileSync, statSync } from 'node:fs';
import OpenAI from 'openai';
import Anthropic, { toFile } from '@anthropic-ai/sdk';

// # GPT por la puerta OpenAI (gpt-5-nano)
// bun run foundry.js 1     # responses, hola mundo
// bun run foundry.js 2     # structured output
// bun run foundry.js 3     # tool call
// bun run foundry.js 4     # chat.completions + params
// bun run foundry.js 5     # structured output, chat.completions
// bun run foundry.js 6     # tool call, chat.completions
// bun run foundry.js 7     # stream de responses
// bun run foundry.js 8     # stream de chat.completions sin stream_options
// bun run foundry.js 9     # stream de chat.completions con include_usage
// bun run foundry.js 10    # stream de responses, volcado en crudo
// bun run foundry.js 11    # stream de responses con include_usage (400 esperado)
// bun run foundry.js 12    # Claude por la puerta OpenAI (404 esperado)

// # Claude Hosted on Anthropic (claude-haiku-5-5)
// bun run foundry.js anthropic-1     # hola mundo
// bun run foundry.js anthropic-2     # structured output
// bun run foundry.js anthropic-3     # tool call
// bun run foundry.js anthropic-4     # generation params
// bun run foundry.js anthropic-5     # structured output con tool
// bun run foundry.js anthropic-6     # tool call en streaming
// bun run foundry.js anthropic-7     # stream
// bun run foundry.js anthropic-8     # stream, volcado en crudo
// bun run foundry.js anthropic-9     # stream con thinking
// bun run foundry.js anthropic-10    # count_tokens
// bun run foundry.js anthropic-11    # batches (404 del proxy)
// bun run foundry.js anthropic-12    # multi-turno + prompt caching

// # Claude Hosted on Azure (claude-haiku-4-5): los mismos
// bun run foundry.js azure-1         # ... hasta azure-12

// # Modelos
// bun run foundry.js model1               # catálogo de modelos del recurso
// bun run foundry.js model2 <MODEL_ID>    # un modelo (por defecto gpt-5-nano)

// # Ficheros, Hosted on Azure (almacén del lado OpenAI)
// bun run foundry.js azure-file1              # sube el PDF
// bun run foundry.js azure-file2              # lista
// bun run foundry.js azure-file3 <FILE_ID>    # recupera los metadatos
// bun run foundry.js azure-file4 <FILE_ID>    # pregunta a gpt-5-nano por file_id
// bun run foundry.js azure-file5 <FILE_ID>    # borra y comprueba que ya no existe
// bun run foundry.js azure-file6              # PDF en base64 a claude-haiku-4-5
// bun run foundry.js azure-file7              # file_id de Anthropic a claude-haiku-4-5 (400 esperado)

// # Ficheros, Hosted on Anthropic (Files API de Anthropic)
// bun run foundry.js anthropic-file1              # sube el PDF
// bun run foundry.js anthropic-file2              # lista
// bun run foundry.js anthropic-file3 <FILE_ID>    # metadatos y descarga (400 esperado)
// bun run foundry.js anthropic-file4 <FILE_ID>    # pregunta a claude-haiku-5-5 por file_id
// bun run foundry.js anthropic-file5 <FILE_ID>    # borra y comprueba el 404
// bun run foundry.js anthropic-file6              # PDF en base64 a claude-haiku-5-5

// - <FILE_ID> es opcional: sin él, la prueba sube el PDF y lo borra al terminar. Sólo *-file1 lo deja subido.
// - Los id no se cruzan: assistant-... para azure-file*, file_... para anthropic-file*.
// - Todo lo de claude-haiku-4-5 da 403 ahora mismo (azure-*, azure-file6, azure-file7), hasta que la proxy-app permita ese modelo.

const PROXY_APP_ID = 'proxy-app-id';
const API_KEY = 'ax_344-example';

// Deployments of the Foundry resource, named exactly as in the portal.
// GPT_DEPLOYMENT goes through /openai, the Claude ones through /anthropic.
const GPT_DEPLOYMENT = 'gpt-5-nano';

const CLAUDE_AZURE_DEPLOYMENT = 'claude-haiku-4-5';
const CLAUDE_ANTHROPIC_DEPLOYMENT = 'claude-haiku-5-5';

const PROXY = `https://axium-foundry-api.jollystone-fb421088.swedencentral.azurecontainerapps.io/v1/proxy-apps/${PROXY_APP_ID}`;

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

// The tests mirror openai.js and anthropic.js, with the Claude ones repeated
// for each hosting:
//
//   node foundry.js 1                 -> OpenAI gate, GPT deployment
//   node foundry.js azure-1           -> Anthropic gate, Claude hosted on Azure
//   node foundry.js anthropic-1       -> Anthropic gate, Claude hosted on Anthropic
//   node foundry.js model1            -> models
//   node foundry.js azure-file1       -> files, OpenAI file store
//   node foundry.js anthropic-file1   -> files, Anthropic Files API
const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
const [, claude_hosting, claude_number] =
  arg.match(/^(azure|anthropic)-(\d+)$/) ?? [];
const claude_test = claude_number ? Number(claude_number) : null;
// model tests, called by name: node foundry.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;
// file tests, called by hosting and name: node foundry.js azure-file1
const file_test = /^(azure|anthropic)-file\d+$/.test(arg) ? arg : null;

const FILES_BETA = 'files-api-2025-04-14';

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
    // the whole output goes back in: a reasoning deployment rejects a
    // function_call that arrives without its reasoning item
    input: [
      ...input,
      ...first.output,
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
// The GPT-5 deployments reject `max_tokens` and the sampling params
// (temperature, top_p): Microsoft's 400 "Unsupported parameter", passed through
// as is. `max_completion_tokens` is the one they accept.
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

// test 5 - structured output, chat.completions flavour
if (test_execution === 5) {
  const response = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [
      {
        role: 'system',
        content: 'Extract the event information from the user message.',
      },
      {
        role: 'user',
        content:
          'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
      },
    ],
    max_completion_tokens: 2000,
    reasoning_effort: 'minimal',
    response_format: {
      type: 'json_schema',
      json_schema: {
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

  const choice = response.choices[0];

  console.log('finish_reason:', choice.finish_reason);
  console.log('refusal:', choice.message.refusal);
  console.log('usage:', response.usage);

  const event = JSON.parse(choice.message.content);

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}

// test 6 - tool call happy path, chat.completions flavour
if (test_execution === 6) {
  const tools = [
    {
      type: 'function',
      function: {
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
    },
  ];

  // fake implementation, always succeeds
  function get_weather({ city, unit }) {
    return { city, unit, temperature: 27, conditions: 'sunny' };
  }

  const messages = [
    {
      role: 'user',
      content: 'What is the weather like in Barcelona right now, in celsius?',
    },
  ];

  const first = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
  });

  const calls = first.choices[0].message.tool_calls ?? [];
  console.log('finish_reason:', first.choices[0].finish_reason);
  console.log(
    'tool calls:',
    calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(', '),
  );

  // the whole assistant message goes back in, tool_calls included
  messages.push(first.choices[0].message);

  for (const call of calls) {
    const result = get_weather(JSON.parse(call.function.arguments));

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }

  const second = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages,
    tools,
    max_completion_tokens: 2000,
  });

  console.log('finish_reason:', second.choices[0].finish_reason);
  console.log(second.choices[0].message.content);
}

// test 7 - responses stream
if (test_execution === 7) {
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

// test 8 - chat.completions stream, WITHOUT stream_options
// Without the flag no chunk carries usage, unless the proxy injects it.
if (test_execution === 8) {
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

// test 9 - chat.completions stream, WITH stream_options.include_usage
// The last chunk arrives with choices: [] and the usage of the whole generation.
if (test_execution === 9) {
  const stream = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
    seed: 42,
    max_completion_tokens: 300,
    reasoning_effort: 'minimal',
    stream: true,
    stream_options: { include_usage: true },
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
    usage_chunk ?? '(NONE: the proxy does not forward the final chunk)',
  );
  console.log('usage:', usage);
}

// test 10 - responses stream, WITHOUT stream_options
// No flag here: the usage comes inside response.completed.
if (test_execution === 10) {
  const stream = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    input: 'Tell me three names in a row',
    reasoning: { effort: 'minimal' },
    stream: true,
  });

  let text = '';
  let index = 0;
  let usage = null;

  for await (const event of stream) {
    // every event exactly as it arrives, unfiltered and ungrouped
    console.log(`--- event ${index++} ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.response?.usage) usage = event.response.usage;
  }

  console.log('--- accumulated text ---');
  console.log(text);
  console.log('events:', index);
  console.log('usage:', usage ?? '(NONE: response.completed is missing)');
}

// test 11 - responses stream, sending stream_options.include_usage anyway
// The SDK only types include_obfuscation inside stream_options on this API, so
// include_usage travels as an unknown parameter: either it is ignored and the
// usage still comes in response.completed, or the gate answers 400.
if (test_execution === 11) {
  let stream;

  try {
    stream = await openai.responses.create({
      model: GPT_DEPLOYMENT,
      input: 'Tell me three names in a row',
      reasoning: { effort: 'minimal' },
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (error) {
    console.log('the request failed:');
    print_error(error);
    process.exit(1);
  }

  let text = '';
  let index = 0;
  let usage = null;

  for await (const event of stream) {
    // every event exactly as it arrives, unfiltered and ungrouped
    console.log(`--- event ${index++} ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.response?.usage) usage = event.response.usage;
  }

  console.log('--- accumulated text ---');
  console.log(text);
  console.log('events:', index);
  console.log('usage:', usage ?? '(NONE: response.completed is missing)');
}

// ===========================================================================
// Wrong gate
// ===========================================================================

// test 12 - Claude deployment through the OpenAI gate
// chat.completions does not serve a Claude deployment: Microsoft's 404
// "api_not_supported", passed through as is.
if (test_execution === 12) {
  try {
    const response = await openai.chat.completions.create({
      model: CLAUDE_ANTHROPIC_DEPLOYMENT,
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

// ===========================================================================
// Anthropic gate (/anthropic) - Claude deployments
// ===========================================================================
// The same twelve tests as anthropic.js, once per hosting. Same proxy-app and
// same key as the OpenAI gate:
//
//   node foundry.js azure-1      -> Claude hosted on Azure
//   node foundry.js anthropic-1  -> Claude hosted on Anthropic
//
// The two deployments are different model generations, so two request options
// change with the hosting: how thinking is asked for and whether
// output_config.effort exists.
const CLAUDE =
  claude_hosting === 'azure'
    ? {
        model: CLAUDE_AZURE_DEPLOYMENT,
        // claude-haiku-4-5: manual thinking budget, no effort parameter
        thinking: { type: 'enabled', budget_tokens: 1024 },
        effort: {},
      }
    : {
        model: CLAUDE_ANTHROPIC_DEPLOYMENT,
        // claude-haiku-5-5: adaptive thinking, regulated by effort
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: { output_config: { effort: 'low' } },
      };

if (claude_test)
  console.log(`[claude hosted on ${claude_hosting}: ${CLAUDE.model}]`);

const event_schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    date: { type: 'string' },
    city: { type: 'string' },
    participants: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'date', 'city', 'participants'],
  additionalProperties: false,
};

const weather_tool = {
  name: 'get_weather',
  description: 'Get the current temperature for a given city.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name, e.g. Barcelona' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city', 'unit'],
    additionalProperties: false,
  },
};

// fake implementation, always succeeds
function get_weather({ city, unit }) {
  return { city, unit, temperature: 27, conditions: 'sunny' };
}

const weather_question =
  'What is the weather like in Barcelona right now, in celsius? Use the get_weather tool.';

// claude test 1 - hello world
// A request rejected by a safety classifier arrives as HTTP 200 with
// stop_reason refusal, so stop_reason is checked before reading the content.
if (claude_test === 1) {
  const response = await anthropic.messages.create({
    model: CLAUDE.model,
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

// claude test 2 - structured output
// output_config.format forces the answer to be valid JSON against the schema.
if (claude_test === 2) {
  const response = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 1024,
    system: 'Extract the event information from the user message.',
    messages: [
      {
        role: 'user',
        content:
          'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
      },
    ],
    output_config: { format: { type: 'json_schema', schema: event_schema } },
  });

  console.log('stop_reason:', response.stop_reason);

  const event = JSON.parse(text_of(response));

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}

// claude test 3 - tool call happy path
// Manual loop: first call -> tool_use blocks -> they run -> every tool_result
// goes back in ONE user message -> second call -> text.
if (claude_test === 3) {
  const tools = [weather_tool];
  const messages = [{ role: 'user', content: weather_question }];

  const first = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 1024,
    tools,
    tool_choice: { type: 'auto' },
    messages,
  });

  const calls = first.content.filter((b) => b.type === 'tool_use');
  console.log('stop_reason:', first.stop_reason);
  console.log(
    'tool calls:',
    calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', '),
  );

  // the whole assistant content goes back in, tool_use blocks included
  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(get_weather(call.input)),
    })),
  });

  const second = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 1024,
    tools,
    messages,
  });

  console.log('stop_reason:', second.stop_reason);
  console.log(text_of(second));
}

// claude test 4 - generation params
// The cuts (max_tokens, stop_sequences), metadata.user_id for traceability and,
// where the deployment has it, the effort.
if (claude_test === 4) {
  const response = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 200,
    system: 'Answer in a single line.',
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
    stop_sequences: ['###'],
    metadata: { user_id: 'axium-test-user' },
    ...CLAUDE.effort,
  });

  console.log('id:', response.id);
  console.log('type:', response.type);
  console.log('model:', response.model);
  console.log('stop_reason:', response.stop_reason);
  console.log('stop_sequence:', response.stop_sequence);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}

// claude test 5 - structured output, tool flavour
// The classic alternative to output_config.format: a strict tool whose input IS
// the JSON we want. With tool_choice auto the model has to pick the tool, so
// the system prompt asks for it.
if (claude_test === 5) {
  const response = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 1024,
    system:
      'Extract the event information from the user message. Always answer by calling the calendar_event tool.',
    tools: [
      {
        name: 'calendar_event',
        description: 'Record the event mentioned in the message.',
        strict: true,
        input_schema: event_schema,
      },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content:
          'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
      },
    ],
  });

  const call = response.content.find((b) => b.type === 'tool_use');

  console.log('stop_reason:', response.stop_reason);
  console.log('usage:', response.usage);

  if (!call) {
    console.log('the model did not call the tool:', text_of(response));
    process.exit(1);
  }

  // the input of a strict tool is already validated against the schema
  console.log(call.input);
  console.log('participants:', call.input.participants.join(', '));
}

// claude test 6 - tool call happy path, streaming flavour
// Same loop as test 3 with messages.stream(): the tool input arrives in pieces
// (input_json_delta) and finalMessage() hands over the complete Message.
if (claude_test === 6) {
  const tools = [weather_tool];
  const messages = [{ role: 'user', content: weather_question }];

  let input_deltas = 0;

  const first_stream = anthropic.messages.stream({
    model: CLAUDE.model,
    max_tokens: 1024,
    tools,
    messages,
  });

  first_stream.on('streamEvent', (event) => {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'input_json_delta'
    ) {
      input_deltas++;
      process.stdout.write(event.delta.partial_json);
    }
  });

  const first = await first_stream.finalMessage();
  console.log('\ninput_json_delta received:', input_deltas);
  console.log('stop_reason:', first.stop_reason);

  const calls = first.content.filter((b) => b.type === 'tool_use');
  console.log(
    'tool calls:',
    calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', '),
  );

  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(get_weather(call.input)),
    })),
  });

  const second_stream = anthropic.messages.stream({
    model: CLAUDE.model,
    max_tokens: 1024,
    tools,
    messages,
  });

  second_stream.on('text', (delta) => process.stdout.write(delta));

  const second = await second_stream.finalMessage();
  console.log('\nstop_reason:', second.stop_reason);
}

// claude test 7 - stream
// Same prompt as test 1, streamed. The deltas print as they arrive, so a proxy
// that buffers the whole response shows: the text comes out all at once.
if (claude_test === 7) {
  const started = performance.now();

  const stream = anthropic.messages.stream({
    model: CLAUDE.model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
  });

  let events = 0;

  for await (const event of stream) {
    events++;

    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
    }
  }

  console.log('\n\nevents received:', events);
  console.log('total time:', Math.round(performance.now() - started), 'ms');
}

// claude test 8 - stream, raw event dump
// Anthropic has no usage flag. The SSE always carries:
//
//   message_start -> usage with input_tokens (and the cache ones)
//   message_delta -> usage with the final output_tokens + stop_reason
//   message_stop  -> close; without it the SDK hangs
if (claude_test === 8) {
  const stream = anthropic.messages.stream({
    model: CLAUDE.model,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Tell me three names in a row' }],
  });

  let text = '';
  let index = 0;
  let input_usage = null;
  let output_usage = null;
  let stop_reason = null;

  for await (const event of stream) {
    // every event exactly as it arrives, unfiltered and ungrouped
    console.log(`--- event ${index++} (${event.type}) ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'message_start') input_usage = event.message.usage;
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      text += event.delta.text;
    }
    if (event.type === 'message_delta') {
      output_usage = event.usage;
      stop_reason = event.delta.stop_reason;
    }
  }

  console.log('--- accumulated text ---');
  console.log(text);
  console.log('events:', index);
  console.log(
    'stop_reason:',
    stop_reason ?? '(NONE: message_delta is missing)',
  );
  console.log('usage in message_start:', input_usage);
  console.log(
    'usage in message_delta:',
    output_usage ?? '(NONE: message_delta is missing)',
  );
}

// claude test 9 - stream with thinking
// The thinking block arrives before the text and ends with a signature_delta.
// How thinking is requested depends on the deployment (see CLAUDE above).
if (claude_test === 9) {
  const stream = anthropic.messages.stream({
    model: CLAUDE.model,
    max_tokens: 2048,
    thinking: CLAUDE.thinking,
    // a question that needs working out: adaptive thinking skips trivial ones
    messages: [
      {
        role: 'user',
        content: 'How many prime numbers are there between 100 and 150?',
      },
    ],
  });

  const blocks = [];

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start':
        blocks.push(event.content_block.type);
        process.stdout.write(`\n[${event.content_block.type}] `);
        break;
      case 'content_block_delta':
        if (event.delta.type === 'thinking_delta') {
          process.stdout.write(event.delta.thinking);
        }
        if (event.delta.type === 'text_delta') {
          process.stdout.write(event.delta.text);
        }
        if (event.delta.type === 'signature_delta') {
          process.stdout.write(' <signature>');
        }
        break;
    }
  }

  const message = await stream.finalMessage();

  console.log('\n\nblocks:', blocks.join(' -> '));
  console.log('stop_reason:', message.stop_reason);
  console.log('usage:', message.usage);
}

// claude test 10 - count_tokens
// POST /messages/count_tokens: counts the input tokens without generating
// anything. Compared against the input_tokens reported by the real request.
if (claude_test === 10) {
  const params = {
    model: CLAUDE.model,
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

// claude test 11 - batches
// POST /messages/batches: asynchronous batch. It is created, processing_status
// is polled until "ended" and the results are read by custom_id. The failure is
// printed instead of thrown: Foundry may not serve this route.
if (claude_test === 11) {
  const request = (custom_id, content) => ({
    custom_id,
    params: {
      model: CLAUDE.model,
      max_tokens: 100,
      messages: [{ role: 'user', content }],
    },
  });

  try {
    const batch = await anthropic.messages.batches.create({
      requests: [
        request('names', 'Tell me three names in a row'),
        request('cities', 'Tell me three cities in a row'),
      ],
    });

    console.log('id:', batch.id);
    console.log('processing_status:', batch.processing_status);
    console.log('request_counts:', batch.request_counts);

    let current = batch;
    while (current.processing_status !== 'ended') {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      current = await anthropic.messages.batches.retrieve(batch.id);
      console.log(
        'polling:',
        current.processing_status,
        current.request_counts,
      );
    }

    for await (const result of await anthropic.messages.batches.results(
      batch.id,
    )) {
      if (result.result.type === 'succeeded') {
        console.log(
          `[${result.custom_id}] ${result.result.message.stop_reason}:`,
          text_of(result.result.message),
        );
      } else {
        console.log(
          `[${result.custom_id}] ${result.result.type}:`,
          result.result.error ?? '',
        );
      }
    }
  } catch (error) {
    print_error(error);
  }
}

// claude test 12 - multi-turn conversation + prompt caching
// The history is built by sending response.content back whole. The system
// carries cache_control: on the second request the prefix is already cached and
// usage.cache_read_input_tokens stops being 0. The prefix needs a minimum size
// (up to 4096 tokens depending on the model), hence the filler.
if (claude_test === 12) {
  const filler =
    'You are an assistant of the Axium platform. You answer briefly and plainly. '.repeat(
      300,
    );

  const system = [
    { type: 'text', text: filler, cache_control: { type: 'ephemeral' } },
  ];
  const messages = [{ role: 'user', content: 'Tell me three names in a row' }];

  const first = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 200,
    system,
    messages,
  });
  console.log('turn 1:', text_of(first));
  console.log('usage 1:', first.usage);

  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: 'Now give me three surnames for those names',
  });

  const second = await anthropic.messages.create({
    model: CLAUDE.model,
    max_tokens: 200,
    system,
    messages,
  });
  console.log('turn 2:', text_of(second));
  console.log('usage 2:', second.usage);

  const read = second.usage.cache_read_input_tokens;
  console.log(
    'cache_read_input_tokens:',
    read ?? '(missing)',
    read > 0 ? '(cache active)' : '',
  );
}

// --- models api -----------------------------------------------------------
// GET /openai/v1/models on Foundry returns the model catalogue of the resource
// (hundreds of entries, Claude included), not only what is deployed.

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
// Same six tests as openai.js and anthropic.js, once per hosting:
//
//   azure-file1..7     -> the resource's OpenAI file store, through /openai
//   anthropic-file1..6 -> the Anthropic Files API, through /anthropic
//
// The two stores are separate: a file_id from one means nothing on the other
// (`assistant-...` on the OpenAI store, `file_...` on the Anthropic one). The
// Axium Files screen lists only the OpenAI store.
//
// These routes carry no model in the body, so the proxy routes them by the
// provider of the proxy-app's DEFAULT model: that model must live in the Foundry
// provider. The proxy forwards them as they are and the resource answers.
//
// Every test accepts a file_id as argv[3]; if missing, it uploads the PDF first
// and deletes it at the end, so each one can run on its own.

const pdf_path = new URL('./pedro-sample.pdf', import.meta.url);
const pdf_name = 'pedro-sample.pdf';
const question = 'Summarize this PDF in five bullet points.';

// Prints the status and the body of a failed call instead of the SDK stack.
function print_error(error) {
  console.log('status:', error.status);
  console.log('error:', JSON.stringify(error.error ?? error.message, null, 2));
}

// ===========================================================================
// Hosted on Azure - OpenAI file store (/openai)
// ===========================================================================
// `assistants` and not `user_data`: Foundry accepts a `user_data` upload and
// serves it by id, but does not support that purpose and leaves the file out
// of the file listing.

function azure_upload() {
  return openai.files.create({
    file: createReadStream(pdf_path),
    purpose: 'assistants',
  });
}

async function azure_ensure_file() {
  if (process.argv[3]) return { id: process.argv[3], mine: false };

  const file = await azure_upload();

  console.log('uploaded for the test:', file.id);
  return { id: file.id, mine: true };
}

// Foundry processes uploads asynchronously: `pending` -> `running` ->
// `processed`. A file that is not `processed` yet cannot be referenced.
async function azure_wait_processed(id) {
  let file = await openai.files.retrieve(id);

  while (file.status === 'pending' || file.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    file = await openai.files.retrieve(id);
  }

  return file;
}

// azure-file1 - upload
// If bytes does not match the real size of the PDF, something along the way is
// touching the body. The file is NOT deleted: reuse its id in the other tests.
if (file_test === 'azure-file1') {
  const size = statSync(pdf_path).size;

  const file = await azure_upload();

  console.log('id:', file.id);
  console.log('object:', file.object);
  console.log('filename:', file.filename);
  console.log(
    'bytes:',
    file.bytes,
    '| on disk:',
    size,
    file.bytes === size ? '(ok)' : '(MISMATCH)',
  );
  console.log('purpose:', file.purpose);
  console.log('status:', file.status);
  console.log('\nreusable: node foundry.js azure-file3', file.id);
}

// azure-file2 - list files
// Azure pages oddly: it can report has_more: true and return an empty next
// page, so has_more is not a reliable signal here.
if (file_test === 'azure-file2') {
  const pager = await openai.files.list();

  let count = 0;

  for await (const f of pager) {
    count++;
    console.log(`${count}. ${f.id}`);
    console.log(
      '   filename:',
      f.filename,
      '| bytes:',
      f.bytes,
      '| purpose:',
      f.purpose,
    );
    if (count >= 50) {
      console.log('   ...');
      break;
    }
  }

  console.log('total files (walked):', count);
}

// azure-file3 - retrieve one file
// Metadata only. Right after an upload the status is `pending`.
if (file_test === 'azure-file3') {
  const { id, mine } = await azure_ensure_file();

  const file = await openai.files.retrieve(id);

  console.log(file);

  if (mine) {
    await openai.files.delete(id);
    console.log('deleted:', id);
  }
}

// azure-file4 - prompt about the file
// The PDF travels by reference (input_file + file_id) to a deployment served
// by the OpenAI gate.
if (file_test === 'azure-file4') {
  const { id, mine } = await azure_ensure_file();

  try {
    const file = await azure_wait_processed(id);
    console.log('status:', file.status);

    const response = await openai.responses.create({
      model: GPT_DEPLOYMENT,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_file', file_id: id },
            { type: 'input_text', text: question },
          ],
        },
      ],
    });

    // The model the provider reports, not the one requested.
    console.log('model:', response.model);
    console.log('usage:', response.usage);
    console.log(response.output_text);
  } finally {
    if (mine) {
      await openai.files.delete(id);
      console.log('deleted:', id);
    }
  }
}

// azure-file5 - delete a file
// After the delete, the retrieve must fail.
if (file_test === 'azure-file5') {
  const { id } = await azure_ensure_file();

  const deleted = await openai.files.delete(id);

  console.log('id:', deleted.id);
  console.log('object:', deleted.object);
  console.log('deleted:', deleted.deleted);

  try {
    const zombie = await openai.files.retrieve(id);
    console.log('the file is still there:', zombie.id, zombie.status);
  } catch (error) {
    console.log('retrieve after the delete:');
    print_error(error);
  }
}

// azure-file6 - the PDF in base64, to the Claude deployment hosted on Azure
// No Files API involved: the PDF travels inside the body as a base64 document
// block. It is the only way to hand a file to a Claude hosted on Azure.
if (file_test === 'azure-file6') {
  const pdf = readFileSync(pdf_path);
  const data = pdf.toString('base64');

  console.log('pdf bytes:', pdf.length, '| base64 chars:', data.length);

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_AZURE_DEPLOYMENT,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data },
            },
            { type: 'text', text: question },
          ],
        },
      ],
    });

    console.log('model:', response.model);
    console.log('stop_reason:', response.stop_reason);
    console.log('usage:', response.usage);
    console.log(text_of(response));
  } catch (error) {
    print_error(error);
  }
}

// azure-file7 - file_id against the Claude deployment hosted on Azure
// The upload reaches the Anthropic Files API of the resource, but a Claude
// hosted on Azure cannot read it: Microsoft's 400 "files_api not supported in
// your workspace", passed through as is.
if (file_test === 'azure-file7') {
  const { id, mine } = await anthropic_ensure_file();

  try {
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_AZURE_DEPLOYMENT,
      max_tokens: 2000,
      betas: [FILES_BETA],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: id } },
            { type: 'text', text: question },
          ],
        },
      ],
    });

    console.log('unexpected, it answered:', text_of(response));
  } catch (error) {
    print_error(error);
  } finally {
    if (mine) {
      await anthropic.beta.files.delete(id);
      console.log('deleted:', id);
    }
  }
}

// ===========================================================================
// Hosted on Anthropic - Anthropic Files API (/anthropic)
// ===========================================================================
// Works only when the resource has a Claude deployment hosted on Anthropic
// infrastructure. The SDK sends `anthropic-beta: files-api-2025-04-14` on
// beta.files calls; the proxy forwards the header but never adds it.

function anthropic_upload() {
  return toFile(createReadStream(pdf_path), pdf_name, {
    type: 'application/pdf',
  }).then((file) => anthropic.beta.files.upload({ file }));
}

// A function declaration, so azure-file7 above can call it.
async function anthropic_ensure_file() {
  if (process.argv[3]) return { id: process.argv[3], mine: false };

  const file = await anthropic_upload();

  console.log('uploaded for the test:', file.id);
  return { id: file.id, mine: true };
}

// anthropic-file1 - upload
// If size_bytes does not match the real size of the PDF, something along the
// way is touching the body. The file is NOT deleted: reuse its id in the other
// tests.
if (file_test === 'anthropic-file1') {
  const size = statSync(pdf_path).size;

  const file = await anthropic_upload();

  console.log('id:', file.id);
  console.log('type:', file.type);
  console.log('filename:', file.filename);
  console.log('mime_type:', file.mime_type);
  console.log(
    'size_bytes:',
    file.size_bytes,
    '| on disk:',
    size,
    file.size_bytes === size ? '(ok)' : '(MISMATCH)',
  );
  console.log('downloadable:', file.downloadable);
  console.log('\nreusable: node foundry.js anthropic-file3', file.id);
}

// anthropic-file2 - list files
if (file_test === 'anthropic-file2') {
  const pager = await anthropic.beta.files.list();

  let count = 0;

  for await (const f of pager) {
    count++;
    console.log(`${count}. ${f.id}`);
    console.log(
      '   filename:',
      f.filename,
      '| size_bytes:',
      f.size_bytes,
      '| mime_type:',
      f.mime_type,
    );
    if (count >= 50) {
      console.log('   ...');
      break;
    }
  }

  console.log('total files (walked):', count);
}

// anthropic-file3 - retrieve the metadata of one file
// Metadata only. The content (files.download) is served only for files created
// by tools: for an uploaded file the provider answers 400 file_not_downloadable.
if (file_test === 'anthropic-file3') {
  const { id, mine } = await anthropic_ensure_file();

  const file = await anthropic.beta.files.retrieveMetadata(id);

  console.log(file);

  try {
    await anthropic.beta.files.download(id);
    console.log('download: served');
  } catch (error) {
    console.log('download:');
    print_error(error);
  }

  if (mine) {
    await anthropic.beta.files.delete(id);
    console.log('deleted:', id);
  }
}

// anthropic-file4 - prompt about the file
// The PDF travels by reference (document + source.type file) to the Claude
// deployment hosted on Anthropic.
if (file_test === 'anthropic-file4') {
  const { id, mine } = await anthropic_ensure_file();

  try {
    const response = await anthropic.beta.messages.create({
      model: CLAUDE_ANTHROPIC_DEPLOYMENT,
      max_tokens: 2000,
      betas: [FILES_BETA],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: id } },
            { type: 'text', text: question },
          ],
        },
      ],
    });

    console.log('model:', response.model);
    console.log('stop_reason:', response.stop_reason);
    console.log('usage:', response.usage);
    console.log(text_of(response));
  } finally {
    if (mine) {
      await anthropic.beta.files.delete(id);
      console.log('deleted:', id);
    }
  }
}

// anthropic-file5 - delete a file
// After the delete, the retrieve must give 404.
if (file_test === 'anthropic-file5') {
  const { id } = await anthropic_ensure_file();

  const deleted = await anthropic.beta.files.delete(id);

  console.log('id:', deleted.id);
  console.log('type:', deleted.type);

  try {
    const zombie = await anthropic.beta.files.retrieveMetadata(id);
    console.log('the file is still there:', zombie.id);
  } catch (error) {
    console.log('retrieve after the delete:');
    print_error(error);
  }
}

// anthropic-file6 - the PDF in base64, without uploading it first
// No Files API involved: the PDF travels inside the body as a base64 document
// block, to compare its usage against anthropic-file4.
if (file_test === 'anthropic-file6') {
  const pdf = readFileSync(pdf_path);
  const data = pdf.toString('base64');

  console.log('pdf bytes:', pdf.length, '| base64 chars:', data.length);

  const response = await anthropic.messages.create({
    model: CLAUDE_ANTHROPIC_DEPLOYMENT,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data },
          },
          { type: 'text', text: question },
        ],
      },
    ],
  });

  console.log('model:', response.model);
  console.log('stop_reason:', response.stop_reason);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}
