import { createReadStream, statSync } from 'node:fs';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// Microsoft Foundry a través del proxy de Axium.
//
// Un provider `foundry` es UN recurso de Foundry (https://<recurso>.services.ai.azure.com)
// que sirve dos APIs con la misma clave:
//
//   - /openai/v1    -> wire format de OpenAI, para todo lo que no sea Claude
//   - /anthropic/v1 -> wire format de Anthropic, sólo para los deployments de Claude
//
// En el proxy NO hay una puerta /foundry: se usa la puerta /openai o la puerta
// /anthropic de siempre y el dialecto de entrada decide a qué puerta del recurso
// va la petición. Por eso aquí hay dos clientes sobre el MISMO proxy-app.
//
// Tres diferencias con openai.js / anthropic.js:
//
//   - el `model` es el NOMBRE DEL DEPLOYMENT tal cual está en el portal de
//     Foundry (el modelo desplegado en Axium tiene que llamarse exactamente igual).
//     Sin prefijo provider/ ni publisher: un nombre que no exista como deployment
//     en el recurso devuelve el 404 de Microsoft "The API deployment for this
//     resource does not exist", pasado tal cual (ver test 10).
//   - no hay api-version ni cliente AzureOpenAI: la puerta v1 de Foundry no lo
//     necesita y el proxy habla el layout plano de OpenAI. Cliente OpenAI normal.
//   - la autenticación hacia el proxy es siempre `Authorization: Bearer ax_...`.
//     El SDK de Anthropic con `apiKey` manda x-api-key, que el proxy no lee, así
//     que se usa `authToken`, que es lo que manda Bearer.
//
// Hacia Foundry el proxy quita la credencial del cliente y pone la del provider
// (api-key en la puerta OpenAI, x-api-key en la puerta Anthropic). Las cabeceras
// anthropic-version / anthropic-beta viajan tal cual.

const PROXY_APP_ID = 'af9c2a1c-284d-465d-9480-163073062b91';
const API_KEY = 'ax_a586097d829f574e8d5412e276b738609432a84d';

// Deployments del recurso de Foundry, tal cual se llaman en el portal.
// GPT_DEPLOYMENT entra por /openai, CLAUDE_DEPLOYMENT por /anthropic.
const GPT_DEPLOYMENT = 'gpt-5-nano';
const CLAUDE_DEPLOYMENT = 'claude-haiku-4-5';

const PROXY = `http://localhost:3000/v1/proxy-apps/${PROXY_APP_ID}`;

// Puerta OpenAI. El segmento /v1 es opcional en el proxy; el SDK añade
// /responses, /chat/completions, /models, /files.
const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: `${PROXY}/openai`,
});

// Puerta Anthropic. authToken -> Authorization: Bearer; apiKey -> x-api-key (no vale).
const anthropic = new Anthropic({
  authToken: API_KEY,
  baseURL: `${PROXY}/anthropic`,
});

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// tests de modelos, se llaman por nombre: node foundry.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;
// tests de ficheros, se llaman por nombre: node foundry.js file1
const file_test = /^file\d+$/.test(arg) ? arg : null;

// los bloques de texto de una respuesta de Anthropic, concatenados
function text_of(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ===========================================================================
// Puerta OpenAI (/openai) - deployment GPT
// ===========================================================================

// test 1 - responses api, hola mundo
if (test_execution === 1) {
  const response = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    input: 'Dime tres nombres seguidos',
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
      content: '¿Qué temperatura hace ahora en Barcelona, en celsius?',
    },
  ];

  const first = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    tools,
    input,
  });

  const call = first.output.find((item) => item.type === 'function_call');

  if (!call) {
    console.log('el modelo no ha llamado a la tool:', first.output_text);
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
// Los deployments de la familia gpt-5 / o-series son modelos de razonamiento:
// en chat.completions rechazan max_tokens (hay que usar max_completion_tokens,
// que incluye los tokens de razonamiento) y solo aceptan temperature y top_p
// por defecto, así que aquí no se mandan. reasoning_effort: 'minimal' deja
// hueco para el texto; con un límite muy bajo el razonamiento se lo come todo y
// content llega vacío con finish_reason: 'length'.
if (test_execution === 4) {
  const response = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
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
// Los deltas se imprimen según llegan, así que si el proxy bufferea la respuesta
// entera se nota porque el texto sale de golpe al final. El usage viaja dentro
// del evento response.completed, sin ningún flag.
if (test_execution === 5) {
  const stream = await openai.responses.create({
    model: GPT_DEPLOYMENT,
    input: 'Dime tres nombres seguidos',
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

  console.log('\n\neventos recibidos:', events);
  console.log('usage:', usage);
}

// test 6 - chat.completions stream, SIN stream_options
// En OpenAI directo, sin stream_options.include_usage todos los chunks llevan
// usage: null. El proxy inyecta stream_options: { include_usage: true } aunque el
// cliente no lo pida, así que aquí SIEMPRE llega el chunk final extra con
// choices: [] y el usage de toda la generación. El cliente tiene que tolerar ese
// chunk sin choices.
if (test_execution === 6) {
  const stream = await openai.chat.completions.create({
    model: GPT_DEPLOYMENT,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
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
    // cada chunk tal cual llega, sin filtrar ni agrupar
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(chunk, null, 2));

    const delta = chunk.choices[0]?.delta?.content;
    if (delta) text += delta;

    if (chunk.usage) {
      usage = chunk.usage;
      usage_chunk = index - 1;
    }
  }

  console.log('--- texto acumulado ---');
  console.log(text);
  console.log('chunks:', index);
  console.log(
    'chunk con usage:',
    usage_chunk ?? '(NINGUNO: el proxy no ha inyectado include_usage)',
  );
  console.log('usage:', usage);
}

// ===========================================================================
// Puerta Anthropic (/anthropic) - deployment Claude
// ===========================================================================
// Sólo messages, messages/count_tokens y streaming. En Foundry NO se prueban
// por esta puerta:
//   - files: el proxy sólo los acepta para el provider anthropic nativo (400)
//   - models: la puerta Anthropic de Foundry no los declara y el proxy no lo
//     guarda, así que lo que llegue es la respuesta cruda de Microsoft
// Para listar deployments y subir ficheros se usa la puerta OpenAI (model1, file1).

// test 7 - messages, hola mundo
if (test_execution === 7) {
  const response = await anthropic.messages.create({
    model: CLAUDE_DEPLOYMENT,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  });

  if (response.stop_reason === 'refusal') {
    console.error('Petición rechazada:', response.stop_details?.category);
    process.exit(1);
  }

  console.log('model:', response.model);
  console.log('usage:', response.usage);
  console.log(text_of(response));
}

// test 8 - messages stream
// En Anthropic no hay flag de usage: message_start trae input_tokens,
// message_delta los output_tokens finales y message_stop cierra (sin él el SDK
// se queda colgado).
if (test_execution === 8) {
  const stream = anthropic.messages.stream({
    model: CLAUDE_DEPLOYMENT,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
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

  console.log('eventos recibidos:', events);
  console.log(
    'message_stop:',
    stop ? 'recibido' : '(NO LLEGA: el proxy se come el cierre)',
  );
}

// test 9 - count_tokens
// POST /messages/count_tokens: cuenta los tokens de entrada sin generar nada.
// Se compara con el input_tokens que reporta la petición real.
if (test_execution === 9) {
  const params = {
    model: CLAUDE_DEPLOYMENT,
    system: 'Responde en una sola línea.',
    messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
  };

  const counted = await anthropic.messages.countTokens(params);
  console.log('count_tokens:', counted);

  const response = await anthropic.messages.create({
    ...params,
    max_tokens: 100,
  });
  console.log('usage real:', response.usage);
  console.log(
    counted.input_tokens === response.usage.input_tokens
      ? 'coinciden'
      : `difieren en ${response.usage.input_tokens - counted.input_tokens}`,
  );
}

// ===========================================================================
// Puerta equivocada
// ===========================================================================

// test 10 - deployment Claude por la puerta OpenAI
// Foundry sirve cada deployment sólo por su puerta. Pedir el deployment de
// Claude por /openai (o el de GPT por /anthropic) no es un 400 del proxy: es el
// 404 de Microsoft "The API deployment for this resource does not exist",
// devuelto en la forma de error del dialecto de entrada. Es el mismo error que
// sale cuando el nombre no coincide con ningún deployment del portal.
if (test_execution === 10) {
  try {
    const response = await openai.chat.completions.create({
      model: CLAUDE_DEPLOYMENT,
      messages: [{ role: 'user', content: 'Dime tres nombres seguidos' }],
    });

    console.log(
      'inesperado, ha contestado:',
      response.choices[0].message.content,
    );
  } catch (err) {
    console.log('status:', err.status);
    console.log('error:', JSON.stringify(err.error ?? err.message, null, 2));
  }
}

// --- models api -----------------------------------------------------------
// GET /openai/v1/models en Foundry lista SÓLO los deployments de la puerta
// OpenAI: los de Claude no aparecen.

// model1 - listar deployments
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

// model2 - recuperar un deployment concreto
if (model_test === 'model2') {
  const id = process.argv[3] ?? GPT_DEPLOYMENT;

  const model = await openai.models.retrieve(id);

  console.log(model);
}

// --- files api ------------------------------------------------------------
// Sólo por la puerta OpenAI, que acepta provider openai y foundry. Estas rutas no
// llevan modelo en el body, así que el proxy las enruta por el provider del
// modelo POR DEFECTO del proxy-app: ese modelo tiene que estar en el provider de
// Foundry o la subida acaba en otro sitio.

const pdf_path = new URL('./sample.pdf', import.meta.url);

// file1 - subida
// Si bytes no coincide con el tamaño real del PDF, alguien está tocando el body
// por el camino.
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
    '| en disco:',
    size,
    file.bytes === size ? '(ok)' : '(NO COINCIDE)',
  );
  console.log('purpose:', file.purpose);
  console.log('\nreutilizable: node foundry.js file2', file.id);
}

// file2 - recuperar y borrar
// Acepta un file_id por argv[3]; si no viene, sube el PDF primero.
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
    console.log('subido para el test:', id);
  }

  const file = await openai.files.retrieve(id);
  console.log(file);

  if (mine) {
    await openai.files.delete(id);
    console.log('borrado:', id);
  }
}
