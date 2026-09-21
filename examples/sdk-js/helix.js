// Petición a Gemini usando UNICAMENTE el transport de helix, sin la fachada
// Helix ni los dialects: el WireRequest se escribe a mano y el transport solo
// pone la URL, la auth y el fetch.
import { GeminiTransport, parseSse, resolveUrl } from '@axium-lab/helix/transports';

const apiKey = '';

// Google AI Studio directo. Es el default de GeminiTransport, pero explícito se
// ve dónde va la petición. resolveUrl solo deduplica el segmento de version, y
// este base no acaba en uno, así que el path del dialecto se cuelga entero:
// <base>/v1beta/models/...
const baseUrl = 'https://generativelanguage.googleapis.com';

const transport = new GeminiTransport({ apiKey, baseUrl });

const model = 'gemini-3.6-flash';

// prepare() añade x-goog-api-key con la apiKey, que es como autentica Google;
// aquí solo queda el content-type, que buildInit no pone por su cuenta.
const authHeaders = {
  'content-type': 'application/json',
};

const test_execution = Number(process.argv[2] ?? 1);


// test 1 - generateContent
if (test_execution === 1) {
  const req = {
    method: 'POST',
    path: `/v1beta/models/${model}:generateContent`,
    headers: authHeaders,
    body: {
      contents: [{ role: 'user', parts: [{ text: 'Dime tres nombres seguidos' }] }],
      generationConfig: { seed: 42 },
    },
  };

  // send() ya llama a prepare() por dentro; esto es solo para ver el sobre.
  const prepared = await transport.prepare(req);
  console.log('URL:', resolveUrl(baseUrl, prepared.path, prepared.query));
  console.log('headers:', Object.keys(prepared.headers).join(', '));

  const res = await transport.send(req);

  // El transport no lanza en un 4xx/5xx: devuelve el status y el body tal cual.
  console.log('status:', res.status);

  if (res.status >= 400) {
    console.log('error body:', JSON.stringify(res.body, null, 2));
  } else {
    const candidate = res.body.candidates[0];
    console.log('finishReason:', candidate.finishReason);
    console.log('usageMetadata:', res.body.usageMetadata);
    console.log(candidate.content.parts.map((p) => p.text).join(''));
  }
}


// test 8 - interactions, structured output (el test 8 de gemini.js)
// Otra ruta, POST /v1beta/interactions, con el model dentro del body y campos
// en snake_case: no es responseMimeType/responseSchema, es response_format.
if (test_execution === 8) {
  const res = await transport.send({
    method: 'POST',
    path: '/v1beta/interactions',
    headers: authHeaders,
    body: {
      model,
      system_instruction: 'Extract the event information from the user message.',
      input: 'Alice and Bob are going to a science fair on Friday at 6pm in Barcelona.',
      // En crudo response_format ES el schema: su 'type' sale de la lista que
      // acepta la API ('object', 'string', 'array'…), no hay envoltorio.
      response_format: {
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
      // 200 no llega: el modelo gasta ~200 tokens solo en thought y la
      // interaction vuelve 'incomplete' con el JSON a medias.
      generation_config: { max_output_tokens: 800 },
    },
  });

  console.log('status:', res.status);

  if (res.status >= 400) {
    console.log('error body:', JSON.stringify(res.body, null, 2));
  } else {
    const interaction = res.body;

    console.log('id:', interaction.id);
    console.log('status:', interaction.status);
    console.log('usage:', interaction.usage);
    console.log('steps:', interaction.steps.map((s) => s.type).join(' -> '));

    // output_text lo compone el SDK a partir de los steps; aquí no hay SDK.
    const outputText = interaction.steps
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');

    const event = JSON.parse(outputText);

    console.log(event);
    console.log('participants:', event.participants.join(', '));
  }
}


// test 2 - streamGenerateContent
// sendStream() devuelve bytes crudos; parseSse los trocea en frames y el
// contenido de cada data: ya es cosa nuestra, no del transport.
// Ojo: sendStream sí lanza cuando la respuesta abre con error, porque en ese
// caso no hay stream que devolver.
if (test_execution === 2) {
  const chunks = transport.sendStream({
    method: 'POST',
    path: `/v1beta/models/${model}:streamGenerateContent`,
    query: { alt: 'sse' },
    headers: authHeaders,
    body: {
      contents: [{ role: 'user', parts: [{ text: 'Dime tres nombres seguidos' }] }],
      generationConfig: { seed: 42, maxOutputTokens: 100 },
    },
  });

  let text = '';

  for await (const frame of parseSse(chunks)) {
    if (frame.data === '[DONE]') break;

    const payload = JSON.parse(frame.data);
    const parts = payload.candidates?.[0]?.content?.parts ?? [];

    for (const part of parts) {
      if (typeof part.text === 'string') {
        text += part.text;
        process.stdout.write(part.text);
      }
    }

    if (payload.usageMetadata) console.log('\nusageMetadata:', payload.usageMetadata);
  }

  console.log('\n---\n' + text);
}
