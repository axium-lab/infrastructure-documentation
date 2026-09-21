import { createReadStream, readFileSync, statSync } from 'node:fs';
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: "ax_8d2d9ff993e24eb6144e8d87e7890a51401eca99",
  baseURL: "http://localhost:3000/v1/proxy-apps/d53365f2-d7b9-441e-8242-535449c90ea3/openai",
});

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// tests de modelos, se llaman por nombre: node openai.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;
// tests de ficheros, se llaman por nombre: node openai.js file1
const file_test = /^file\d+$/.test(arg) ? arg : null;


// test 1
if (test_execution === 1) {
  const response = await client.responses.create({
    model: 'openai/gpt-5.6-luna',
    input: 'Dime tres nombres seguidos'
  });

  console.log(response.output_text);
}


// test 2 - structured output
if (test_execution === 2) {
  const response = await client.responses.create({
    model: 'gpt-4o-mini',
    instructions: 'Extract the event information from the user message.',
    input: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
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

  const input = [
    { role: 'user', content: 'What is the weather like in Barcelona right now, in celsius?' },
  ];

  const first = await client.responses.create({
    model: 'gpt-4o-mini',
    input,
    tools,
  });

  const calls = first.output.filter((item) => item.type === 'function_call');
  console.log('tool calls:', calls.map((c) => `${c.name}(${c.arguments})`).join(', '));

  input.push(...first.output);

  for (const call of calls) {
    const result = get_weather(JSON.parse(call.arguments));

    input.push({
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(result),
    });
  }

  const second = await client.responses.create({
    model: 'gpt-4o-mini',
    input,
    tools,
  });

  console.log(second.output_text);
}


// test 4 - chat.completions + generation params
if (test_execution === 4) {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Dime tres nombres seguidos' },
    ],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 20,
    frequency_penalty: 0.3,
    presence_penalty: 0.3,
    stop: ['\n\n'],
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
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Extract the event information from the user message.' },
      { role: 'user', content: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.' },
    ],
    temperature: 0,
    max_completion_tokens: 200,
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
    const celsius = 27;
    return {
      city,
      unit,
      temperature: unit === 'fahrenheit' ? Math.round(celsius * 9 / 5 + 32) : celsius,
      conditions: 'sunny',
    };
  }

  const messages = [
    { role: 'user', content: 'What is the weather like in Barcelona right now, in celsius?' },
  ];

  const first = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    temperature: 0,
  });

  const calls = first.choices[0].message.tool_calls ?? [];
  console.log('finish_reason:', first.choices[0].finish_reason);
  console.log('tool calls:', calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(', '));

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

  const second = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    tools,
    temperature: 0,
    max_tokens: 200,
  });

  console.log('finish_reason:', second.choices[0].finish_reason);
  console.log(second.choices[0].message.content);
}


// test 7 - stream (responses api)
// Mismo prompt que el test 1 pero con stream: true. Los deltas se imprimen
// según llegan, así que si el proxy bufferea la respuesta entera se nota
// porque el texto sale de golpe al final.
if (test_execution === 7) {
  const stream = await client.responses.create({
    model: 'gpt-4o-mini',
    input: 'Dime tres nombres seguidos',
    stream: true,
  });

  let events = 0;

  for await (const event of stream) {
    events++;

    if (event.type === 'response.output_text.delta') {
      process.stdout.write(event.delta);
    }
  }

  console.log('\n\neventos recibidos:', events);
}


// --- streaming: usage sí / usage no ---------------------------------------
// Equivalentes a los tests 11 y 14 de gemini.js (mismo prompt, cada chunk se
// imprime tal cual llega), pero cruzando las dos apis de OpenAI con el flag de
// usage:
//
//   test  8 - chat.completions, sin stream_options
//   test  9 - chat.completions, con stream_options: { include_usage: true }
//   test 10 - responses, sin stream_options
//   test 11 - responses, con stream_options: { include_usage: true }
//
// En chat.completions el flag es la única forma de ver los tokens en streaming:
// sin él todos los chunks llevan usage: null. Con él OpenAI añade un chunk final
// extra con choices: [] y el usage completo, así que también sirve para ver si el
// proxy se come ese último chunk al cerrar el SSE.
//
// En responses el usage no depende de ningún flag: viaja siempre dentro del
// evento response.completed. El test 11 manda igualmente stream_options para
// comprobar qué hace el proxy con un parámetro que esa api no documenta
// (aceptarlo y ignorarlo, o devolver un 400 de unknown parameter).


// test 8 - chat.completions stream, SIN el flag de usage
if (test_execution === 8) {
  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Dime tres nombres seguidos' },
    ],
    seed: 42,
    max_tokens: 100,
    stream: true,
  });

  let text = '';
  let index = 0;
  let usage = null;

  for await (const chunk of stream) {
    // cada chunk tal cual llega, sin filtrar ni agrupar
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(chunk, null, 2));

    const delta = chunk.choices[0]?.delta?.content;
    if (delta) text += delta;

    // sin stream_options esto tiene que quedarse a null en todos los chunks
    if (chunk.usage) usage = chunk.usage;
  }

  console.log('--- texto acumulado ---');
  console.log(text);
  console.log('chunks:', index);
  console.log('usage:', usage ?? '(ninguno, como se espera sin stream_options)');
}


// test 9 - chat.completions stream, CON stream_options.include_usage
// El último chunk llega con choices: [] y el usage de toda la generación.
if (test_execution === 9) {
  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: 'Dime tres nombres seguidos' },
    ],
    seed: 42,
    max_tokens: 100,
    stream: true,
    stream_options: { include_usage: true },
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
  console.log('chunk con usage:', usage_chunk ?? '(NINGUNO: el proxy no reenvía el chunk final)');
  console.log('usage:', usage);
}


// test 10 - responses stream, SIN stream_options
// Aquí no hay flag que valga: el usage viene dentro de response.completed.
if (test_execution === 10) {
  const stream = await client.responses.create({
    model: 'gpt-4o-mini',
    input: 'Dime tres nombres seguidos',
    max_output_tokens: 100,
    stream: true,
  });

  let text = '';
  let index = 0;
  let usage = null;

  for await (const event of stream) {
    // cada evento tal cual llega, sin filtrar ni agrupar
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.response?.usage) usage = event.response.usage;
  }

  console.log('--- texto acumulado ---');
  console.log(text);
  console.log('eventos:', index);
  console.log('usage:', usage ?? '(NINGUNO: falta el response.completed)');
}


// test 11 - responses stream, mandando stream_options.include_usage igualmente
// El SDK sólo tipa include_obfuscation dentro de stream_options en esta api, así
// que include_usage viaja como parámetro desconocido: o se ignora y el usage sale
// igual por response.completed, o el proxy/OpenAI contesta 400.
if (test_execution === 11) {
  let stream;

  try {
    stream = await client.responses.create({
      model: 'gpt-4o-mini',
      input: 'Dime tres nombres seguidos',
      max_output_tokens: 100,
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (error) {
    console.log('la petición falló:', error.status, JSON.stringify(error.message));
    process.exit(1);
  }

  let text = '';
  let index = 0;
  let usage = null;

  for await (const event of stream) {
    // cada evento tal cual llega, sin filtrar ni agrupar
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(event, null, 2));

    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.response?.usage) usage = event.response.usage;
  }

  console.log('--- texto acumulado ---');
  console.log(text);
  console.log('eventos:', index);
  console.log('usage:', usage ?? '(NINGUNO: falta el response.completed)');
}


// --- models api -----------------------------------------------------------
// client.models.* pega a GET /models y GET /models/<id>


// model1 - listar modelos
// list() devuelve un pager, el async iterator recorre todas las páginas
if (model_test === 'model1') {
  const pager = await client.models.list();

  let count = 0;

  for await (const m of pager) {
    count++;
    console.log(`${count}. ${m.id}`);
    console.log('   object:', m.object, '| owned_by:', m.owned_by, '| created:', m.created);
  }

  console.log('total models:', count);
}


// model2 - recuperar un modelo concreto
if (model_test === 'model2') {
  const id = process.argv[3] ?? 'gpt-4o-mini';

  const model = await client.models.retrieve(id);

  console.log('id:', model.id);
  console.log('object:', model.object);
  console.log('owned_by:', model.owned_by);
  console.log('created:', model.created);
  console.log(model);
}


// --- files api ------------------------------------------------------------
// client.files.* pega a POST /files, GET /files, GET /files/<id> y
// DELETE /files/<id>. Dos cosas que sólo pasan en esta familia de rutas:
//
//   - la subida es la única llamada multipart/form-data del SDK, y el proxy la
//     trata como body crudo (no reparsea el multipart), así que el boundary del
//     cliente tiene que llegar intacto a OpenAI
//   - estas rutas no llevan modelo en el body, así que el proxy las enruta por
//     el provider del modelo por defecto de la app: si la app mezcla providers,
//     un file-... creado contra uno puede resolverse contra otro y dar un 404
//     que no distingue "no existe" de "no es tuyo"
//
// El purpose no lo valida el proxy, viaja tal cual dentro del multipart.

const pdf_path = new URL('./sample.pdf', import.meta.url);

// los tests file* aceptan un file_id por argv[3]; si no viene, suben el PDF,
// así cada uno se puede ejecutar suelto
async function ensure_file() {
  if (process.argv[3]) return { id: process.argv[3], mine: false };

  const file = await client.files.create({
    file: createReadStream(pdf_path),
    purpose: 'user_data',
  });

  console.log('subido para el test:', file.id);
  return { id: file.id, mine: true };
}


// file1 - subida
// Si bytes no coincide con el tamaño real del PDF, alguien está tocando el body
// por el camino (un body parser que se coma el multipart, un límite de tamaño).
if (file_test === 'file1') {
  const size = statSync(pdf_path).size;

  const file = await client.files.create({
    file: createReadStream(pdf_path),
    purpose: 'user_data',
  });

  console.log('id:', file.id);
  console.log('object:', file.object);
  console.log('filename:', file.filename);
  console.log('bytes:', file.bytes, '| en disco:', size, file.bytes === size ? '(ok)' : '(NO COINCIDE)');
  console.log('purpose:', file.purpose);
  console.log('status:', file.status);
  console.log('created_at:', file.created_at, '| expires_at:', file.expires_at);
  console.log('\nreutilizable: node openai.js file3', file.id);
}


// file2 - listar ficheros
// list() devuelve un pager, el async iterator recorre todas las páginas.
// La segunda llamada comprueba que el proxy reenvía los query params.
if (file_test === 'file2') {
  const pager = await client.files.list();

  let count = 0;

  for await (const f of pager) {
    count++;
    console.log(`${count}. ${f.id}`);
    console.log('   filename:', f.filename, '| bytes:', f.bytes, '| purpose:', f.purpose);
  }

  console.log('total files:', count);

  const filtered = await client.files.list({ purpose: 'user_data', limit: 5 });

  console.log('\ncon purpose=user_data&limit=5:');
  for (const f of filtered.data) {
    console.log('  ', f.id, '|', f.filename, '|', f.purpose);
  }
  console.log('   has_more:', filtered.has_more ?? '(no viene)');
}


// file3 - recuperar un fichero concreto
// Sólo metadatos. El contenido (client.files.content(id) -> GET /files/<id>/content)
// lo devuelve el proxy pasado por response.text(), así que hoy no sirve para
// recuperar el PDF intacto: no se prueba aquí a propósito.
if (file_test === 'file3') {
  const { id, mine } = await ensure_file();

  const file = await client.files.retrieve(id);

  console.log('id:', file.id);
  console.log('object:', file.object);
  console.log('filename:', file.filename);
  console.log('bytes:', file.bytes);
  console.log('purpose:', file.purpose);
  console.log('status:', file.status);
  console.log('created_at:', file.created_at, '| expires_at:', file.expires_at);
  console.log(file);

  if (mine) {
    await client.files.delete(id);
    console.log('borrado:', id);
  }
}


// file4 - prompt sobre el fichero
// El PDF va por referencia (input_file + file_id), así que el body de la
// petición baja a unos pocos bytes: es la parte del ciclo que de verdad
// justifica tener el files api en el proxy.
if (file_test === 'file4') {
  const { id, mine } = await ensure_file();

  const response = await client.responses.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_output_tokens: 2000,
    input: [
      {
        role: 'user',
        // el documento va antes que la instrucción
        content: [
          { type: 'input_file', file_id: id },
          { type: 'input_text', text: 'Resume este PDF en cinco puntos, en español.' },
        ],
      },
    ],
  });

  console.log('status:', response.status);
  console.log('usage:', response.usage);
  console.log(response.output_text);

  if (mine) {
    await client.files.delete(id);
    console.log('borrado:', id);
  }
}


// file5 - eliminar un fichero
// Después del delete, el retrieve tiene que dar 404. Se captura para imprimir
// el status en vez de reventar con el stack del SDK.
if (file_test === 'file5') {
  const { id } = await ensure_file();

  const deleted = await client.files.delete(id);

  console.log('id:', deleted.id);
  console.log('object:', deleted.object);
  console.log('deleted:', deleted.deleted);

  try {
    const zombie = await client.files.retrieve(id);
    console.log('el fichero sigue ahí:', zombie.id, zombie.status);
  } catch (error) {
    console.log('retrieve tras el delete:', error.status, JSON.stringify(error.message));
  }
}


// file6 - el fichero en base64, sin subirlo antes
// Aquí no hay files api de por medio: el PDF viaja incrustado en el body del
// chat como data url, así que es un POST /chat/completions normal pero con un
// cuerpo de ~200 KB. Sirve para comprobar que el proxy no recorta el body (su
// límite de JSON es de 10 MB) y es el plan B cuando el files api no está
// disponible o el fichero se resuelve contra el provider equivocado.
if (file_test === 'file6') {
  const pdf = readFileSync(pdf_path);
  const data = pdf.toString('base64');

  console.log('pdf bytes:', pdf.length, '| base64 chars:', data.length);

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        // el documento va antes que la instrucción
        content: [
          {
            type: 'file',
            file: {
              filename: 'sample.pdf',
              file_data: `data:application/pdf;base64,${data}`,
            },
          },
          { type: 'text', text: 'Resume este PDF en cinco puntos, en español.' },
        ],
      },
    ],
  });

  const choice = response.choices[0];

  console.log('finish_reason:', choice.finish_reason);
  console.log('usage:', response.usage);
  console.log(choice.message.content);
}
