import OpenAI from 'openai';

// https://ai.google.dev/gemini-api/docs/openai
// Google sirve sus modelos en el formato de OpenAI bajo /v1beta/openai, asi que el
// SDK de OpenAI solo cambia de baseURL. El proxy expone esa puerta en /gemini/openai
// y autentica con Bearer, igual que Google.
const client = new OpenAI({
  apiKey: "ax_5b8d5ad7de9ac554430ea237070132c0ca9416f8",
  baseURL: "http://localhost:3000/v1/proxy-apps/3d7cf11a-5e28-4eac-a14b-b991e4c2d421/vertex/v1beta1/projects/meh/locations/europe-west1/endpoints/openapi/",
});

const model = 'gemini-3.7-flash';

const arg = process.argv[2] ?? '1';
const test_execution = Number(arg);
// tests de modelos, se llaman por nombre: node gemini-openai.js model1
const model_test = /^model\d+$/.test(arg) ? arg : null;


// test 1
// esta puerta no expone responses, el equivalente es chat.completions
if (test_execution === 1) {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'user', content: 'Dime tres nombres seguidos' },
    ],
  });

  console.log(response.choices[0].message.content);
}
