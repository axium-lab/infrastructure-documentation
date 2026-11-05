import { createReadStream, readFileSync, statSync } from 'node:fs';
import Anthropic, { toFile } from '@anthropic-ai/sdk';

// Dos destinos posibles, se elige con la variable de entorno MOCK:
//
//   - por defecto -> API real de Anthropic a través del proxy de Axium.
//     apiKey es la ax_ key de la app y baseURL la ruta del proxy; el proxy pone
//     la clave real de Anthropic por el camino.
//
//   - con MOCK=1 -> mock de https://llm-mock.dev/api-anthropic.html
//     Es una API falsa compatible con el wire format de Anthropic: contesta
//     "Echo: <prompt>", fabrica tool calls a partir del JSON Schema, soporta
//     streaming, thinking, count_tokens, batches y files, y se controla con
//     cabeceras x-llm-mock-* (ver mock_headers más abajo). Sin estado: la misma
//     petición devuelve siempre la misma respuesta.
const MOCK = false;

const client = new Anthropic(
  MOCK
    ? { apiKey: 'sk-mock-key-01', baseURL: 'https://api.llm-mock.dev/anthropic' }
    : {
        apiKey: 'ax_47e6bf4de076062f5f4e8bb95c74773c1e842c2c',
        baseURL: 'http://localhost:3000/v1/proxy-apps/5ef0597a-45c5-4dae-a500-08b5959ccec9/anthropic',
      },
);

// El mock acepta cualquier id de modelo, así que se usa el mismo en los dos destinos.
const MODEL = 'claude-haiku-5-5';

// Cabeceras de control del mock. En la API real no se mandan (las ignoraría,
// pero así queda claro qué parte del test es artificial):
//   x-llm-mock-response   -> texto exacto de la respuesta (ASCII)
//   x-llm-mock-tool-calls -> JSON [{ name, arguments }] con las tool calls exactas
function mock_headers(headers) {
  return MOCK ? { headers } : {};
}

// El mock sólo hace tool calls con tool_choice any/tool o con la cabecera
// x-llm-mock-tool-calls; con auto nunca llama. claude-haiku-5-5 sí acepta
// any/tool, pero con tool_choice forzado la respuesta se salta el thinking, así
// que se usa auto + instrucción en el prompt + strict: true (igual que haría
// falta en opus/sonnet 5.5, donde any/tool devuelven 400), y en el mock se
// fuerza la llamada con la cabecera.
function mock_tool_calls(calls) {
  return mock_headers({ 'x-llm-mock-tool-calls': JSON.stringify(calls) });
}

console.log(MOCK ? '[destino: mock llm-mock.dev]' : '[destino: proxy Axium -> API real]');

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// tests de modelos, se llaman por nombre: node anthropic.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;
// tests de ficheros, se llaman por nombre: node anthropic.js file1
const file_test = /^file\d+$/.test(arg) ? arg : null;

// los bloques de texto de una respuesta, concatenados
function text_of(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}


// test 1 - hola mundo
// Si un clasificador de seguridad rechaza la petición, la respuesta llega con
// HTTP 200 y stop_reason refusal. En claude-haiku-5-5 no hay fallback de
// servidor (fallbacks: 'default' no hace nada y una lista de modelos da 400),
// así que se comprueba stop_reason a mano antes de leer el content.
if (test_execution === 1) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  });

  if (response.stop_reason === 'refusal') {
    console.error('Petición rechazada:', response.stop_details?.category);
    process.exit(1);
  }

  console.log(text_of(response));
}


// test 2 - structured output
// output_config.format fuerza que la respuesta sea JSON válido contra el schema.
// El mock no lo implementa (devolvería "Echo: ..."), así que ahí se fija el JSON
// con x-llm-mock-response para que el parseo del test funcione igual.
if (test_execution === 2) {
  const pinned = { name: 'science fair', date: 'Friday 6pm', city: 'Barcelona', participants: ['Alice', 'Bob'] };

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 1024,
      system: 'Extract the event information from the user message.',
      messages: [
        { role: 'user', content: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.' },
      ],
      output_config: {
        format: {
          type: 'json_schema',
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
    },
    mock_headers({ 'x-llm-mock-response': JSON.stringify(pinned) }),
  );

  console.log('stop_reason:', response.stop_reason);

  const event = JSON.parse(text_of(response));

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}


// test 3 - tool call happy path
// Bucle manual: primera llamada -> bloques tool_use -> se ejecutan -> todos los
// tool_result vuelven en UN solo mensaje user -> segunda llamada -> texto.
if (test_execution === 3) {
  const tools = [
    {
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
    },
  ];

  // fake implementation, always succeeds
  function get_weather({ city, unit }) {
    const celsius = 27;
    return {
      city,
      unit,
      temperature: unit === 'fahrenheit' ? Math.round(celsius * 9 / 5 + 32) : celsius,
      conditions: 'sunny',
    };
  }

  const messages = [
    { role: 'user', content: 'What is the weather like in Barcelona right now, in celsius? Use the get_weather tool.' },
  ];

  const first = await client.messages.create(
    { model: MODEL, max_tokens: 1024, tools, tool_choice: { type: 'auto' }, messages },
    mock_tool_calls([{ name: 'get_weather', arguments: { city: 'Barcelona', unit: 'celsius' } }]),
  );

  const calls = first.content.filter((b) => b.type === 'tool_use');
  console.log('stop_reason:', first.stop_reason);
  console.log('tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', '));

  // el content entero del assistant vuelve a entrar, tool_use incluidos
  messages.push({ role: 'assistant', content: first.content });

  messages.push({
    role: 'user',
    content: calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(get_weather(call.input)),
    })),
  });

  const second = await client.messages.create({ model: MODEL, max_tokens: 1024, tools, messages });

  console.log('stop_reason:', second.stop_reason);
  console.log(text_of(second));
}


// test 4 - generation params
// temperature/top_p/top_k ya no existen en esta api (400 en la versión actual):
// lo que se controla es el esfuerzo (output_config.effort) y los cortes
// (max_tokens, stop_sequences). metadata.user_id viaja para trazabilidad.
// Ojo: el thinking va activo por defecto y cuenta contra max_tokens, así que
// un tope muy bajo puede agotarse antes de que salga texto (stop_reason
// max_tokens con el content vacío). Por eso 200 y no 20.
if (test_execution === 4) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: 'Responde en una sola línea.',
    messages: [
      { role: 'user', content: 'Dime tres nombres seguidos' },
    ],
    stop_sequences: ['###'],
    output_config: { effort: 'low' },
    metadata: { user_id: 'axium-test-user' },
  });

  console.log('id:', response.id);
  console.log('type:', response.type);
  console.log('model:', response.model);
  console.log('stop_reason:', response.stop_reason);
  console.log('stop_sequence:', response.stop_sequence);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}


// test 5 - structured output, tool flavour
// La alternativa clásica a output_config.format: una tool strict cuyo input ES
// el JSON que queremos. Con tool_choice auto el modelo tiene que decidirse por
// la tool, así que se le pide en el system; en el mock se fija con la cabecera.
if (test_execution === 5) {
  const pinned = { name: 'science fair', date: 'Friday 6pm', city: 'Barcelona', participants: ['Alice', 'Bob'] };

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 1024,
      system: 'Extract the event information from the user message. Always answer by calling the calendar_event tool.',
      tools: [
        {
          name: 'calendar_event',
          description: 'Record the event mentioned in the message.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              date: { type: 'string' },
              city: { type: 'string' },
              participants: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'date', 'city', 'participants'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.' },
      ],
    },
    mock_tool_calls([{ name: 'calendar_event', arguments: pinned }]),
  );

  const call = response.content.find((b) => b.type === 'tool_use');

  console.log('stop_reason:', response.stop_reason);
  console.log('usage:', response.usage);

  if (!call) {
    console.log('el modelo no llamó a la tool:', text_of(response));
    process.exit(1);
  }

  // en una tool strict el input ya viene validado contra el schema, no hay JSON.parse
  console.log(call.input);
  console.log('participants:', call.input.participants.join(', '));
}


// test 6 - tool call happy path, streaming flavour
// Mismo bucle que el test 3 pero con messages.stream(): los deltas de texto se
// pintan según llegan y finalMessage() entrega el Message completo para sacar
// stop_reason y los bloques tool_use. eager_input_streaming hace que el input de
// la tool llegue en trozos (input_json_delta) en vez de en un bloque al final.
if (test_execution === 6) {
  const tools = [
    {
      name: 'get_weather',
      description: 'Get the current temperature for a given city.',
      strict: true,
      eager_input_streaming: true,
      input_schema: {
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

  function get_weather({ city, unit }) {
    return { city, unit, temperature: 27, conditions: 'sunny' };
  }

  const messages = [
    { role: 'user', content: 'What is the weather like in Barcelona right now, in celsius? Use the get_weather tool.' },
  ];

  let input_deltas = 0;

  const first_stream = client.messages.stream(
    { model: MODEL, max_tokens: 1024, tools, messages },
    mock_tool_calls([{ name: 'get_weather', arguments: { city: 'Barcelona', unit: 'celsius' } }]),
  );

  first_stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      input_deltas++;
      process.stdout.write(event.delta.partial_json);
    }
  });

  const first = await first_stream.finalMessage();
  console.log('\ninput_json_delta recibidos:', input_deltas);
  console.log('stop_reason:', first.stop_reason);

  // con eager_input_streaming el servidor ya no valida el input: se comprueba
  // aquí antes de ejecutar nada
  const calls = first.content.filter((b) => b.type === 'tool_use');
  for (const call of calls) {
    if (typeof call.input?.city !== 'string' || !['celsius', 'fahrenheit'].includes(call.input?.unit)) {
      console.log('input de tool inválido o truncado:', JSON.stringify(call.input));
      process.exit(1);
    }
  }
  console.log('tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join(', '));

  messages.push({ role: 'assistant', content: first.content });
  messages.push({
    role: 'user',
    content: calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: JSON.stringify(get_weather(call.input)),
    })),
  });

  const second_stream = client.messages.stream({ model: MODEL, max_tokens: 1024, tools, messages });

  second_stream.on('text', (delta) => process.stdout.write(delta));

  const second = await second_stream.finalMessage();
  console.log('\nstop_reason:', second.stop_reason);
}


// test 7 - stream
// Mismo prompt que el test 1 pero en streaming. Los deltas se imprimen según
// llegan, así que si el proxy bufferea la respuesta entera se nota porque el
// texto sale de golpe al final.
if (test_execution === 7) {
  const started = performance.now();

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  });

  let events = 0;

  for await (const event of stream) {
    events++;

    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
    }
  }

  const elapsed_ms = Math.round(performance.now() - started);

  console.log('\n\neventos recibidos:', events);
  console.log('tiempo total:', elapsed_ms, 'ms');
}


// --- streaming: dónde viaja el usage ---------------------------------------
// Equivalentes a los tests 8-11 de openai.js. En Anthropic no hay flag de usage:
// el SSE lleva siempre
//
//   message_start  -> usage con input_tokens (y los de caché)
//   message_delta  -> usage con output_tokens finales + stop_reason
//   message_stop   -> cierre; sin él el SDK se queda colgado
//
// Cada frame SSE lleva línea event: y línea data:. El test 8 vuelca los eventos
// tal cual para ver si el proxy respeta eso y no se come el message_delta final.


// test 8 - stream, volcado de eventos en crudo
if (test_execution === 8) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  });

  let text = '';
  let index = 0;
  let input_usage = null;
  let output_usage = null;
  let stop_reason = null;

  for await (const event of stream) {
    // cada evento tal cual llega, sin filtrar ni agrupar
    console.log(`--- evento ${index++} (${event.type}) ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'message_start') input_usage = event.message.usage;
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text;
    if (event.type === 'message_delta') {
      output_usage = event.usage;
      stop_reason = event.delta.stop_reason;
    }
  }

  console.log('--- texto acumulado ---');
  console.log(text);
  console.log('eventos:', index);
  console.log('stop_reason:', stop_reason ?? '(NINGUNO: falta el message_delta)');
  console.log('usage en message_start:', input_usage);
  console.log('usage en message_delta:', output_usage ?? '(NINGUNO: falta el message_delta)');
}


// test 9 - stream con thinking
// En claude-haiku-5-5 el thinking es adaptativo y va activo por defecto (se
// regula con output_config.effort, por defecto medium); display controla sólo
// si se ve: "omitted" (por defecto) deja los bloques thinking vacíos,
// "summarized" devuelve un resumen. El bloque thinking llega antes que el texto
// y termina con un signature_delta.
if (test_execution === 9) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  });

  let blocks = [];

  for await (const event of stream) {
    switch (event.type) {
      case 'content_block_start':
        blocks.push(event.content_block.type);
        process.stdout.write(`\n[${event.content_block.type}] `);
        break;
      case 'content_block_delta':
        if (event.delta.type === 'thinking_delta') process.stdout.write(event.delta.thinking);
        if (event.delta.type === 'text_delta') process.stdout.write(event.delta.text);
        if (event.delta.type === 'signature_delta') process.stdout.write(' <signature>');
        break;
    }
  }

  const message = await stream.finalMessage();

  console.log('\n\nbloques:', blocks.join(' -> '));
  console.log('stop_reason:', message.stop_reason);
  console.log('usage:', message.usage);
}


// test 10 - count_tokens
// POST /messages/count_tokens: cuenta los tokens de entrada sin generar nada
// (gratis). Se compara con el input_tokens que reporta la petición real.
if (test_execution === 10) {
  const params = {
    model: MODEL,
    system: 'Responde en una sola línea.',
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  };

  const counted = await client.messages.countTokens(params);
  console.log('count_tokens:', counted);

  const response = await client.messages.create({ ...params, max_tokens: 100 });
  console.log('usage real:', response.usage);
  console.log(
    counted.input_tokens === response.usage.input_tokens
      ? 'coinciden'
      : `difieren en ${response.usage.input_tokens - counted.input_tokens}`,
  );
}


// test 11 - batches
// POST /messages/batches: lote asíncrono a mitad de precio. Se crea, se hace
// polling de processing_status hasta "ended" y se leen los resultados (JSONL,
// en cualquier orden: siempre por custom_id). En el mock el lote termina al
// instante.
if (test_execution === 11) {
  const batch = await client.messages.batches.create({
    requests: [
      { custom_id: 'nombres', params: { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }] } },
      { custom_id: 'ciudades', params: { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'Dime tres ciudades seguidas' }] } },
    ],
  });

  console.log('id:', batch.id.slice(0, 40) + (batch.id.length > 40 ? '…' : ''));
  console.log('processing_status:', batch.processing_status);
  console.log('request_counts:', batch.request_counts);

  let current = batch;
  while (current.processing_status !== 'ended') {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    current = await client.messages.batches.retrieve(batch.id);
    console.log('polling:', current.processing_status, current.request_counts);
  }

  console.log('results_url:', current.results_url);

  let results;
  try {
    results = await client.messages.batches.results(batch.id);
  } catch (error) {
    // El mock devuelve results_url en http://, que redirige a https y en la
    // redirección se pierde x-api-key -> 401. Se vuelve a pedir en https.
    if (!MOCK || error.status !== 401) throw error;
    console.log('results() dio 401 por el redirect http->https del mock, reintentando en https');
    const res = await fetch(current.results_url.replace(/^http:/, 'https:'), {
      headers: { 'x-api-key': 'sk-mock-key-01', 'anthropic-version': '2023-06-01' },
    });
    results = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
  }

  for await (const result of results) {
    if (result.result.type === 'succeeded') {
      console.log(`[${result.custom_id}] ${result.result.message.stop_reason}:`, text_of(result.result.message));
    } else {
      console.log(`[${result.custom_id}] ${result.result.type}:`, result.result.error ?? '');
    }
  }
}


// test 12 - conversación multi-turno + prompt caching
// El historial se construye reenviando response.content entero (no sólo el
// texto). El system lleva cache_control: en la segunda petición el prefijo ya
// está cacheado y usage.cache_read_input_tokens deja de ser 0. Hace falta un
// prefijo mínimo (según modelo, hasta 4096 tokens) o la caché no aplica, por
// eso el system se rellena. El mock no reporta campos de caché.
if (test_execution === 12) {
  const filler = 'Eres un asistente de la plataforma Axium. Respondes en español, de forma breve y sin adornos. '.repeat(300);

  const system = [{ type: 'text', text: filler, cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: 'Dime tres nombres seguidos' }];

  const first = await client.messages.create({ model: MODEL, max_tokens: 200, system, messages });
  console.log('turno 1:', text_of(first));
  console.log('usage 1:', first.usage);

  messages.push({ role: 'assistant', content: first.content });
  messages.push({ role: 'user', content: 'Ahora dime tres apellidos para esos nombres' });

  const second = await client.messages.create({ model: MODEL, max_tokens: 200, system, messages });
  console.log('turno 2:', text_of(second));
  console.log('usage 2:', second.usage);

  const read = second.usage.cache_read_input_tokens;
  console.log('cache_read_input_tokens:', read ?? '(no viene)', read > 0 ? '(caché activa)' : '');
}


// --- models api -----------------------------------------------------------
// client.models.* pega a GET /models y GET /models/<id>. Además del id, cada
// modelo trae max_input_tokens (ventana), max_tokens (tope de salida) y
// capabilities (thinking, effort, structured outputs...).


// model1 - listar modelos
// list() devuelve un pager, el async iterator recorre todas las páginas
if (model_test === 'model1') {
  const pager = await client.models.list();

  let count = 0;

  for await (const m of pager) {
    count++;
    console.log(`${count}. ${m.id}`);
    console.log('   display_name:', m.display_name, '| created_at:', m.created_at);
    console.log('   max_input_tokens:', m.max_input_tokens ?? '(no viene)', '| max_tokens:', m.max_tokens ?? '(no viene)');
  }

  console.log('total models:', count);
}


// model2 - recuperar un modelo concreto
// El catálogo del mock no incluye claude-haiku-5-5 (en /messages acepta cualquier
// id, pero en /models/<id> da 404), por eso ahí el valor por defecto es otro.
if (model_test === 'model2') {
  const id = process.argv[3] ?? (MOCK ? 'claude-opus-5' : MODEL);

  const model = await client.models.retrieve(id);

  console.log('id:', model.id);
  console.log('display_name:', model.display_name);
  console.log('created_at:', model.created_at);
  console.log('max_input_tokens:', model.max_input_tokens ?? '(no viene)');
  console.log('max_tokens:', model.max_tokens ?? '(no viene)');
  console.log('capabilities:', JSON.stringify(model.capabilities ?? '(no vienen)', null, 2));
}


// --- files api ------------------------------------------------------------
// client.files.* pega a POST /files, GET /files, GET /files/<id> y
// DELETE /files/<id>. La subida es multipart/form-data, así que el proxy tiene
// que dejar pasar el body crudo con su boundary. Los ficheros se referencian
// luego desde messages con { type: "document", source: { type: "file", file_id } }.
//
// En la API real el files api ya es estable (client.files, sin cabecera beta).
// El mock sigue exigiendo la cabecera files-api-2025-04-14 y por tanto el
// namespace beta; se elige aquí para que los tests file* sean idénticos.

const pdf_path = new URL('./sample.pdf', import.meta.url);

const files_api = MOCK ? client.beta.files : client.files;
const messages_api = MOCK ? client.beta.messages : client.messages;
const files_betas = MOCK ? { betas: ['files-api-2025-04-14'] } : {};

// los tests file* aceptan un file_id por argv[3]; si no viene, suben el PDF,
// así cada uno se puede ejecutar suelto
async function ensure_file() {
  if (process.argv[3]) return { id: process.argv[3], mine: false };

  const file = await files_api.upload({
    file: await toFile(createReadStream(pdf_path), 'sample.pdf', { type: 'application/pdf' }),
    ...files_betas,
  });

  console.log('subido para el test:', file.id);
  return { id: file.id, mine: true };
}


// file1 - subida
// Si size_bytes no coincide con el tamaño real del PDF, alguien está tocando el
// body por el camino (un body parser que se coma el multipart, un límite de tamaño).
if (file_test === 'file1') {
  const size = statSync(pdf_path).size;

  const file = await files_api.upload({
    file: await toFile(createReadStream(pdf_path), 'sample.pdf', { type: 'application/pdf' }),
    ...files_betas,
  });

  console.log('id:', file.id);
  console.log('type:', file.type);
  console.log('filename:', file.filename);
  console.log('mime_type:', file.mime_type);
  console.log('size_bytes:', file.size_bytes, '| en disco:', size, file.size_bytes === size ? '(ok)' : '(NO COINCIDE)');
  console.log('created_at:', file.created_at);
  console.log('downloadable:', file.downloadable);
  console.log('\nreutilizable: node anthropic.js file3', file.id);
}


// file2 - listar ficheros
// list() devuelve un pager, el async iterator recorre todas las páginas.
// La segunda llamada comprueba que el proxy reenvía los query params.
if (file_test === 'file2') {
  const pager = await files_api.list({ ...files_betas });

  let count = 0;

  for await (const f of pager) {
    count++;
    console.log(`${count}. ${f.id}`);
    console.log('   filename:', f.filename, '| size_bytes:', f.size_bytes, '| mime_type:', f.mime_type);
    if (count >= 50) { console.log('   ...'); break; }
  }

  console.log('total files (recorridos):', count);

  const filtered = await files_api.list({ limit: 2, ...files_betas });

  console.log('\ncon limit=2:');
  for (const f of filtered.data) {
    console.log('  ', f.id, '|', f.filename, '|', f.mime_type);
  }
  console.log('   has_more:', filtered.has_more ?? '(no viene)');
}


// file3 - recuperar los metadatos de un fichero concreto
// Sólo metadatos. El contenido (files.download) sólo está disponible para
// ficheros generados por la API, no para los subidos: no se prueba aquí.
if (file_test === 'file3') {
  const { id, mine } = await ensure_file();

  const file = await files_api.retrieveMetadata(id, { ...files_betas });

  console.log('id:', file.id);
  console.log('type:', file.type);
  console.log('filename:', file.filename);
  console.log('mime_type:', file.mime_type);
  console.log('size_bytes:', file.size_bytes);
  console.log('created_at:', file.created_at);
  console.log('downloadable:', file.downloadable);
  console.log(file);

  if (mine) {
    await files_api.delete(id, { ...files_betas });
    console.log('borrado:', id);
  }
}


// file4 - prompt sobre el fichero
// El PDF va por referencia (document + source.type file), así que el body de la
// petición baja a unos pocos bytes: es la parte del ciclo que de verdad
// justifica tener el files api en el proxy.
if (file_test === 'file4') {
  const { id, mine } = await ensure_file();

  const response = await messages_api.create({
    model: MODEL,
    max_tokens: 2000,
    ...files_betas,
    messages: [
      {
        role: 'user',
        // el documento va antes que la instrucción
        content: [
          { type: 'document', source: { type: 'file', file_id: id } },
          { type: 'text', text: 'Resume este PDF en cinco puntos, en español.' },
        ],
      },
    ],
  });

  console.log('stop_reason:', response.stop_reason);
  console.log('usage:', response.usage);
  console.log(text_of(response));

  if (mine) {
    await files_api.delete(id, { ...files_betas });
    console.log('borrado:', id);
  }
}


// file5 - eliminar un fichero
// Después del delete, el retrieve tiene que dar 404. Se captura para imprimir
// el status en vez de reventar con el stack del SDK. Ojo: el mock no guarda
// estado (el id codifica el fichero), así que ahí el retrieve sigue dando 200.
if (file_test === 'file5') {
  const { id } = await ensure_file();

  const deleted = await files_api.delete(id, { ...files_betas });

  console.log('id:', deleted.id);
  console.log('type:', deleted.type);

  try {
    const zombie = await files_api.retrieveMetadata(id, { ...files_betas });
    console.log('el fichero sigue ahí:', zombie.id, MOCK ? '(esperado en el mock: no tiene estado)' : '(NO DEBERÍA)');
  } catch (error) {
    console.log('retrieve tras el delete:', error.status, JSON.stringify(error.message));
  }
}


// file6 - el fichero en base64, sin subirlo antes
// Aquí no hay files api de por medio: el PDF viaja incrustado en el body como
// bloque document base64, así que es un POST /messages normal pero con un
// cuerpo de ~200 KB. Sirve para comprobar que el proxy no recorta el body y es
// el plan B cuando el files api no está disponible.
if (file_test === 'file6') {
  const pdf = readFileSync(pdf_path);
  const data = pdf.toString('base64');

  console.log('pdf bytes:', pdf.length, '| base64 chars:', data.length);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        // el documento va antes que la instrucción
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          { type: 'text', text: 'Resume este PDF en cinco puntos, en español.' },
        ],
      },
    ],
  });

  console.log('stop_reason:', response.stop_reason);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}
