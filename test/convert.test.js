import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAiCompletion } from '@gladysassistant/integration-sdk';
import {
  hasImages,
  textOf,
  toMistralMessages,
  toMistralToolChoice,
  toMistralToolId,
  toMistralTools,
  toOpenAiCompletion,
} from '../src/convert.js';

test('tool call ids: kept when Mistral-shaped, else nine stable characters', () => {
  assert.equal(toMistralToolId('aB3dE5gH9'), 'aB3dE5gH9');
  for (const id of [
    'unknown',
    'tool_call_unknown',
    'call_abc123XYZ',
    'toolu_01A09q90qw90lq917835lq9',
    undefined,
  ]) {
    const mapped = toMistralToolId(id);
    assert.match(mapped, /^[a-zA-Z0-9]{9}$/, String(id));
    assert.equal(toMistralToolId(id), mapped, 'stable');
  }
  assert.notEqual(toMistralToolId('call_1'), toMistralToolId('call_2'));
  assert.equal(toMistralToolId(undefined), toMistralToolId('unknown'));
});

test('the messages of a tool-calling turn of the core convert, ids still matching', () => {
  const messages = toMistralMessages([
    { role: 'system', content: 'You are Gladys.' },
    { role: 'user', content: 'Allume le salon' },
    { role: 'assistant', content: 'Je regarde.', tool_calls: [] },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc123XYZ',
          type: 'function',
          function: { name: 'device_set_value', arguments: '{"room":"salon"}' },
        },
        {
          id: 'Q1w2E3r4T',
          type: 'function',
          function: { name: 'device_get_state', arguments: { room: 'salon' } },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc123XYZ', content: 'ok' },
    { role: 'tool', tool_call_id: 'Q1w2E3r4T', content: [{ type: 'text', text: '{"on":true}' }] },
    { role: 'tool', tool_call_id: 'unknown', content: 'Unknown tool: x', name: 'x' },
    { role: 'function', content: 'legacy' },
  ]);
  assert.equal(messages.length, 7, 'the unknown role is dropped');
  assert.deepEqual(messages[0], { role: 'system', content: 'You are Gladys.' });
  assert.deepEqual(messages[2], { role: 'assistant', content: 'Je regarde.' });
  const [first, second] = messages[3].tool_calls;
  assert.equal(messages[3].content, undefined, 'no empty content next to tool calls');
  assert.equal(messages[4].tool_call_id, first.id);
  assert.equal(second.id, 'Q1w2E3r4T');
  assert.equal(messages[5].tool_call_id, 'Q1w2E3r4T');
  assert.equal(second.function.arguments, '{"room":"salon"}', 'object arguments become JSON');
  assert.equal(messages[5].content, '{"on":true}');
  assert.equal(messages[6].name, 'x');
});

test('user images pass as image_url chunks, text-only lists become a string', () => {
  const [withImage, textOnly, empty] = toMistralMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Qui est devant la porte ?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } },
        { type: 'input_audio', input_audio: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    },
    { role: 'user', content: null },
  ]);
  assert.deepEqual(withImage.content, [
    { type: 'text', text: 'Qui est devant la porte ?' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/AA==' } },
  ]);
  assert.equal(textOnly.content, 'a\nb');
  assert.equal(empty.content, '');
  assert.equal(
    hasImages([{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }]),
    true,
  );
  assert.equal(hasImages([{ role: 'user', content: 'x' }]), false);
});

test('tools and tool_choice: Mistral spelling, known keys only', () => {
  assert.deepEqual(
    toMistralTools([
      {
        type: 'function',
        function: { name: 'a', description: 'd', parameters: { type: 'object' }, strict: true },
      },
      { type: 'function', function: { name: 'b' } },
      { type: 'web_search' },
    ]),
    [
      {
        type: 'function',
        function: { name: 'a', parameters: { type: 'object' }, description: 'd' },
      },
      { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
    ],
  );
  assert.equal(toMistralToolChoice('required'), 'any');
  assert.equal(toMistralToolChoice('auto'), 'auto');
  assert.equal(toMistralToolChoice('none'), 'none');
  assert.deepEqual(toMistralToolChoice({ type: 'function', function: { name: 'a' } }), {
    type: 'function',
    function: { name: 'a' },
  });
  assert.equal(toMistralToolChoice(undefined), undefined);
});

test('a reasoning answer gives the core its text only, as a valid completion', () => {
  const completion = toOpenAiCompletion({
    id: 'c1',
    model: 'mistral-large-4',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'The user wants…' }] },
            { type: 'text', text: 'Le salon est allumé.' },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(completion.choices[0].message.content, 'Le salon est allumé.');
  assert.deepEqual(validateAiCompletion(completion), []);
  assert.equal(textOf([{ type: 'thinking', thinking: [{ type: 'text', text: 'x' }] }]), '');
});

test('tool calls come back with string arguments, null content, bounded', () => {
  const calls = Array.from({ length: 25 }, (_, index) => ({
    id: `id${String(index).padStart(7, '0')}`,
    function: { name: index === 0 ? 'bad name!' : 'device_set_value', arguments: { value: index } },
  }));
  const completion = toOpenAiCompletion({
    choices: [{ message: { content: '', tool_calls: calls } }],
  });
  const { message } = completion.choices[0];
  assert.equal(message.content, null);
  assert.equal(message.tool_calls.length, 20);
  assert.equal(message.tool_calls[0].function.arguments, '{"value":1}');
  assert.equal(message.tool_calls[0].type, 'function');
  assert.deepEqual(validateAiCompletion(completion), []);
  // No answer at all: an empty text, never undefined.
  assert.equal(toOpenAiCompletion({}).choices[0].message.content, '');
});
