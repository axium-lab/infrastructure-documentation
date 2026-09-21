import { readFileSync } from 'node:fs';
import { GoogleGenAI, Type, createPartFromBase64, createUserContent } from '@google/genai';


  const ai = new GoogleGenAI({
    vertexai: true,
    project: 'lo-que-sea',        // Axium lo descarta: usa el del provider
    location: 'global',     // este SÍ cuenta, decide la región de Google
    apiKey: "ax_34d7b1add3da3ceb7d67e6035ae75183e29b1912", // Se descarta, pero así no se intenta usar ADC
    httpOptions: {
      baseUrl: `http://localhost:3000/v1/proxy-apps/686f2125-be80-45f6-b559-f96163924c29/vertex`
    },
  });

// En Vertex el modelo es un publisher model: si el nombre lleva una barra el SDK
// la parte en publishers/<publisher>/models/<modelo>, y si no la lleva asume
// publishers/google. Ojo, parte por la PRIMERA barra y descarta el resto, así que
// un id de modelo que llevase otra barra se quedaría a medias.
const model = 'google/gemini-3.5-flash-lite';

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// tests de modelos, se llaman por nombre: node vertex.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;


// test 1
if (test_execution === 1) {
  const response = await ai.models.generateContent({
    model,
    contents: 'Que modelo eres?',
    config: {
      seed: 42,
    },
  });

  console.log(response.text);
}


// test 2 - structured output
if (test_execution === 2) {
  const response = await ai.models.generateContent({
    model,
    contents: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
    config: {
      systemInstruction: 'Extract the event information from the user message.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          date: { type: Type.STRING },
          city: { type: Type.STRING },
          participants: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['name', 'date', 'city', 'participants'],
        propertyOrdering: ['name', 'date', 'city', 'participants'],
      },
    },
  });

  const event = JSON.parse(response.text);

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}


// test 3 - tool call happy path
if (test_execution === 3) {
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get the current temperature for a given city.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              city: { type: Type.STRING, description: 'City name, e.g. Barcelona' },
              unit: { type: Type.STRING, enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city', 'unit'],
          },
        },
      ],
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

  const contents = [
    { role: 'user', parts: [{ text: 'What is the weather like in Barcelona right now, in celsius?' }] },
  ];

  const first = await ai.models.generateContent({
    model,
    contents,
    config: { tools },
  });

  const calls = first.functionCalls ?? [];
  console.log('tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', '));

  // the whole model turn goes back in, functionCall parts included
  contents.push(first.candidates[0].content);

  contents.push({
    role: 'user',
    parts: calls.map((call) => ({
      functionResponse: {
        // Vertex no numera los functionCall como AI Studio: si no viene id, no
        // se manda, porque un id undefined hace que rechace el turno.
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        response: get_weather(call.args),
      },
    })),
  });

  const second = await ai.models.generateContent({
    model,
    contents,
    config: { tools },
  });

  console.log(second.text);
}


// test 4 - chats + generation params
if (test_execution === 4) {
  const chat = ai.chats.create({
    model,
    config: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 20,
      stopSequences: ['\n\n'],
      seed: 42,
    },
  });

  const response = await chat.sendMessage({ message: 'Dime tres nombres seguidos' });


  const candidate = response.candidates[0];

  console.log('responseId:', response.responseId);
  console.log('modelVersion:', response.modelVersion);
  console.log('finishReason:', candidate.finishReason);
  console.log('usageMetadata:', response.usageMetadata);
  console.log(response.text);
}


// test 5 - structured output, chats flavour
if (test_execution === 5) {
  const chat = ai.chats.create({
    model,
    config: {
      systemInstruction: 'Extract the event information from the user message.',
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          date: { type: Type.STRING },
          city: { type: Type.STRING },
          participants: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['name', 'date', 'city', 'participants'],
        propertyOrdering: ['name', 'date', 'city', 'participants'],
      },
    },
  });

  console.log("chat")

  const response = await chat.sendMessage({
    message: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
  });

    console.log("response", response)


  const candidate = response.candidates[0];
  console.log('candidate:', JSON.stringify(candidate, null, 2));

  console.log('finishReason:', candidate.finishReason);
  console.log('usageMetadata:', response.usageMetadata);

  const event = JSON.parse(response.text);

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}


// test 6 - tool call happy path, chats flavour
if (test_execution === 6) {
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: 'Get the current temperature for a given city.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              city: { type: Type.STRING, description: 'City name, e.g. Barcelona' },
              unit: { type: Type.STRING, enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city', 'unit'],
          },
        },
      ],
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

  const config = {
    tools,
    toolConfig: {
      functionCallingConfig: { mode: 'AUTO' },
    },
    temperature: 0,
  };

  // the chat keeps the history, so the model turn is replayed for us
  const chat = ai.chats.create({ model, config });

  const first = await chat.sendMessage({
    message: 'What is the weather like in Barcelona right now, in celsius?',
  });

  const calls = first.functionCalls ?? [];
  console.log('finishReason:', first.candidates[0].finishReason);
  console.log('tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', '));

  const second = await chat.sendMessage({
    message: calls.map((call) => ({
      functionResponse: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        response: get_weather(call.args),
      },
    })),
    config: { ...config, maxOutputTokens: 200 },
  });

  console.log('finishReason:', second.candidates[0].finishReason);
  console.log(second.text);
}


// --- interactions api -----------------------------------------------------
// ai.interactions.* pega a POST /{api_version}/interactions, no a
// /publishers/google/models/<model>:<verbo>, así que son otra ruta más que el
// proxy tendría que exponer bajo /vertex.


// test 7 - interactions, basic
if (test_execution === 7) {
  const interaction = await ai.interactions.create({
    model,
    input: 'Dime tres nombres seguidos',
    generation_config: { seed: 42 },
  });

  console.log('id:', interaction.id);
  console.log('status:', interaction.status);
  console.log('usage:', interaction.usage);
  console.log('steps:', interaction.steps.map((s) => s.type).join(' -> '));
  console.log(interaction.output_text);
}


// test 8 - interactions, structured output
// no responseMimeType/responseSchema here, it is response_format
if (test_execution === 8) {
  const interaction = await ai.interactions.create({
    model,
    system_instruction: 'Extract the event information from the user message.',
    input: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          date: { type: 'string' },
          city: { type: 'string' },
          participants: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'date', 'city', 'participants'],
        propertyOrdering: ['name', 'date', 'city', 'participants'],
      },
    },
    generation_config: { max_output_tokens: 200 },
  });

  const event = JSON.parse(interaction.output_text);

  console.log(event);
  console.log('participants:', event.participants.join(', '));
}


// test 9 - interactions, tool call happy path (stateless)
// the whole history is replayed as steps, no interaction id involved
if (test_execution === 9) {
  const tools = [
    {
      type: 'function',
      name: 'get_weather',
      description: 'Get the current temperature for a given city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, e.g. Barcelona' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city', 'unit'],
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

  const prompt = 'What is the weather like in Barcelona right now, in celsius?';

  const first = await ai.interactions.create({
    model,
    tools,
    input: prompt,
  });

  const calls = first.steps.filter((s) => s.type === 'function_call');
  console.log('status:', first.status);
  console.log('tool calls:', calls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(', '));

  const second = await ai.interactions.create({
    model,
    tools,
    input: [
      { type: 'user_input', content: [{ type: 'text', text: prompt }] },
      // the model turn goes back in verbatim, function_call steps included
      ...first.steps.filter((s) => s.type !== 'user_input'),
      ...calls.map((call) => ({
        type: 'function_result',
        call_id: call.id,
        name: call.name,
        result: get_weather(call.arguments),
      })),
    ],
    generation_config: { max_output_tokens: 200 },
  });

  console.log('status:', second.status);
  console.log(second.output_text);
}


// test 10 - interactions, server side history
// store keeps the turn, previous_interaction_id chains the next one
if (test_execution === 10) {
  const first = await ai.interactions.create({
    model,
    store: true,
    input: 'Dime tres nombres seguidos',
    generation_config: { seed: 42, max_output_tokens: 100000 },
  });

  console.log('first id:', first.id);
  console.log(first.output_text);

  console.log("--- end of first interaction ---")

  const second = await ai.interactions.create({
    model,
    store: true,
    previous_interaction_id: first.id,
    input: 'Ahora ordénalos alfabéticamente',
    generation_config: { max_output_tokens: 10000 },
  });

  console.log('second id:', second.id);
  console.log('previous_interaction_id:', second.previous_interaction_id);
  console.log("second result:", second.output_text);

  console.log("--- end of second interaction ---")

  // and it should be retrievable afterwards
  const fetched = await ai.interactions.get(first.id, { include_input: true });
  console.log('fetched status:', fetched.status);
  console.log('fetched steps:', fetched.steps.map((s) => s.type).join(' -> '));

  await ai.interactions.delete(first.id);
  await ai.interactions.delete(second.id);
  console.log('deleted');
}


// test 11 - interactions, streaming
// create() returns an async iterable of SSE events instead of an interaction
if (test_execution === 11) {
  const stream = await ai.interactions.create({
    model,
    stream: true,
    input: 'Dime tres nombres seguidos',
    generation_config: { seed: 42, max_output_tokens: 100 },
  });

  let text = '';

  for await (const event of stream) {
    if (event.event_type === 'step.delta' && event.delta?.type === 'text') {
      text += event.delta.text;
      continue;
    }
    console.log('event:', event.event_type);
    if (event.event_type === 'interaction.completed') {
      console.log('usage:', event.interaction?.usage);
    }
  }

  console.log(text);
}


// test 12 - interactions, background lifecycle
// background returns immediately, the interaction is polled or cancelled
if (test_execution === 12) {
  const started = await ai.interactions.create({
    model,
    store: true,
    background: true,
    input: 'Escribe un resumen largo de la historia de Barcelona',
    generation_config: { max_output_tokens: 800 },
  });

  console.log('id:', started.id, 'status:', started.status);

  let current = started;

  for (let i = 0; i < 10 && (current.status === 'queued' || current.status === 'in_progress'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      current = await ai.interactions.get(started.id);
      console.log('poll', i, current.status);
    } catch (error) {
      // while the background turn is still generating, the get answers 403/400
      // instead of queued/in_progress, so a failed poll is not a failed test
      console.log('poll', i, 'transient', error.status, error.error?.error?.code);
    }
  }

  if (current.status === 'queued' || current.status === 'in_progress') {
    const cancelled = await ai.interactions.cancel(started.id);
    console.log('cancelled status:', cancelled.status);
  } else {
    console.log(current.output_text);
  }

  await ai.interactions.delete(started.id);
  console.log('deleted');
}


// --- streaming ------------------------------------------------------------


// test 14 - generateContentStream
// POST .../publishers/google/models/<model>:streamGenerateContent?alt=sse
// mismo escenario que el test 11 pero por la models api: aquí cada chunk es un
// GenerateContentResponse completo (candidates/parts), no un evento SSE de
// interactions, y se vuelca entero para ver qué manda el proxy en cada uno
if (test_execution === 14) {
  const stream = await ai.models.generateContentStream({
    model,
    contents: 'Dime tres nombres seguidos',
    config: { seed: 42, maxOutputTokens: 100 },
  });

  let text = '';
  let index = 0;

  for await (const chunk of stream) {
    // cada chunk tal cual llega, sin filtrar ni agrupar
    console.log(`--- chunk ${index++} ---`);
    console.log(JSON.stringify(chunk, null, 2));

    if (chunk.text) text += chunk.text;
  }

  console.log('--- texto acumulado ---');
  console.log(text);
}


// --- multimodal -----------------------------------------------------------


// test 15 - PDF en base64 (inlineData)
// El fichero viaja incrustado en el body, sin subirlo antes al Files API: es un
// POST .../publishers/<pub>/models/<model>:generateContent normal, pero con una
// part inlineData de ~200 KB en base64, así que también prueba que el proxy no
// recorta el cuerpo de la petición.
if (test_execution === 15) {
  const pdf = readFileSync(new URL('./sample.pdf', import.meta.url));
  const data = pdf.toString('base64');

  console.log('pdf bytes:', pdf.length, '| base64 chars:', data.length);

  const response = await ai.models.generateContent({
    model,
    // el documento va antes que la instrucción, que es como Google recomienda
    contents: createUserContent([
      createPartFromBase64(data, 'application/pdf'),
      'Resume este PDF en cinco puntos, en español.',
    ]),
    config: { temperature: 0, maxOutputTokens: 800 },
  });

  const candidate = response.candidates[0];

  console.log('finishReason:', candidate.finishReason);
  console.log('usageMetadata:', response.usageMetadata);
  console.log(response.text);
}


// --- models api -----------------------------------------------------------
// En modo vertex list() y get() pegan a /publishers/google/models, no a
// /models como en AI Studio


// test 13 / model1 - list models (base models del publisher google)
// list() returns a pager, the async iterator walks every page for us
if (test_execution === 13 || model_test === 'model1') {
  const pager = await ai.models.list({ config: { pageSize: 50, queryBase: true } });

  console.log('page size:', pager.pageLength);
  console.log('has next page:', pager.hasNextPage());

  let count = 0;

  for await (const m of pager) {
    count++;
    console.log(`${count}. ${m.name} (${m.displayName ?? '-'})`);
    console.log('   version:', m.version, '| input:', m.inputTokenLimit, '| output:', m.outputTokenLimit);
    console.log('   supported actions:', (m.supportedActions ?? []).join(', ') || '-');
  }

  console.log('total models:', count);
}


// model2 - recuperar un modelo concreto
// get() pega a GET .../publishers/google/models/<model>, sin verbo
if (model_test === 'model2') {
  const name = process.argv[3] ?? model;

  const info = await ai.models.get({ model: name });

  console.log('name:', info.name);
  console.log('displayName:', info.displayName);
  console.log('version:', info.version);
  console.log('description:', info.description);
  console.log('inputTokenLimit:', info.inputTokenLimit, '| outputTokenLimit:', info.outputTokenLimit);
  console.log('supportedActions:', (info.supportedActions ?? []).join(', ') || '-');
  console.log(info);
}


// model3 - listar modelos página a página
// sin async iterator, para ver el paginado que devuelve el proxy
if (model_test === 'model3') {
  const pager = await ai.models.list({ config: { pageSize: 5, queryBase: true } });

  let page = pager.page;
  let index = 0;

  while (true) {
    index++;
    console.log(`--- page ${index} (${page.length} models) ---`);

    for (const m of page) {
      console.log(`  ${m.name} (${m.displayName ?? '-'})`);
    }

    if (!pager.hasNextPage()) break;

    page = await pager.nextPage();
  }

  console.log('total pages:', index);
}


// model4 - modelos tuneados en vez de los del publisher
// con queryBase: false el SDK filtra por labels.tune-type:* y pega a /models,
// que en Vertex cuelga de projects/<id>/locations/<loc>: sin project/location
// en el cliente esa ruta sale sin prefijo, así que es cosa del proxy resolverla
if (model_test === 'model4') {
  const pager = await ai.models.list({ config: { pageSize: 20, queryBase: false } });

  let count = 0;

  for await (const m of pager) {
    count++;
    console.log(`${count}. ${m.name} (${m.displayName ?? '-'})`);
    console.log('   tunedModelInfo:', m.tunedModelInfo ?? '-');
  }

  console.log('total tuned models:', count);
}
