'use strict';

// Summarises a transcript using llama-completion (llama.cpp) + a local Gemma model.

const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { tail, assertModelExists } = require('./util.js');

const execFileAsync = promisify(execFile);

const DEFAULT_CHUNK_CHARS  = 60000;
const DEFAULT_CTX_SIZE     = 65536;
const DEFAULT_MAX_TOKENS   = 4096;

const SYSTEM_PROMPT = `Ты — аналитик деловых встреч. На вход подаётся транскрипт встречи с указанием говорящих.
Отвечай строго на русском языке, по-деловому и без воды.
Сформируй результат в Markdown ровно с такими разделами:

## Краткое резюме
2–4 предложения о сути встречи.

## Ключевые решения
Маркированный список принятых решений. Включай также: отложенные вопросы, решения передать или вынести на рассмотрение руководства. Если решений нет — напиши «—».

## Action items
Маркированный список задач в формате «**Ответственный** — что сделать (срок, если назван)». Бери ответственных из имён говорящих. Если задач нет — напиши «—».
Если не получилось сопоставить ответственных и говорящих, то просто остановись ровно на том что было зафиксировано. Если ответственные лица вообще не были выбраны, то просто зафиксируй экшен поинты как есть.

Не выдумывай факты, которых нет в транскрипте.`;

const REDUCE_SYSTEM_PROMPT = `Ты — аналитик деловых встреч. Ниже несколько промежуточных конспектов частей одной встречи.
Сведи их в один итоговый результат на русском языке в Markdown с разделами «## Краткое резюме», «## Ключевые решения», «## Action items».
Убери повторы, объедини связанные пункты. Не выдумывай фактов.`;

// Matches llama.cpp control tokens like <|channel>, <channel|>, <|message|>.
const SPECIAL_TOKEN = /<\|?[a-zA-Z_]+\|?>/g;

class Client {
  // temp/seed are optional: temp defaults to 0.2, seed to none (random). They exist so
  // tests can run greedy + fixed-seed for lower output variance; prod leaves them unset.
  constructor(bin, model, { ctxSize = DEFAULT_CTX_SIZE, maxTokens = DEFAULT_MAX_TOKENS, chunkChars = DEFAULT_CHUNK_CHARS, temp = null, seed = null } = {}) {
    this.bin        = bin;
    this.model      = model;
    this.ctxSize    = ctxSize;
    this.maxTokens  = maxTokens;
    this.chunkChars = chunkChars;
    this.temp       = temp;
    this.seed       = seed;
  }

  async summarize(signal, transcript) {
    transcript = transcript.trim();
    if (!transcript) throw new Error('empty transcript');

    assertModelExists(this.model);

    const chunks = splitChunks(transcript, this.chunkChars);

    if (chunks.length === 1) {
      return validate(await this._run(signal, SYSTEM_PROMPT, `Транскрипт:\n\n${chunks[0]}`));
    }

    // Map: summarise each chunk individually.
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      const part = await this._run(signal, SYSTEM_PROMPT,
        `Это часть ${i + 1} из ${chunks.length} транскрипта встречи.\n\nТранскрипт:\n\n${chunks[i]}`);
      partials.push(`### Часть ${i + 1}\n${part}`);
    }

    // Reduce: combine partial summaries.
    return validate(await this._run(signal, REDUCE_SYSTEM_PROMPT,
      `Промежуточные конспекты:\n\n${partials.join('\n\n')}`));
  }

  async _run(signal, system, user) {
    // Build Gemma 4 chat format manually with an empty <think> pre-fill.
    // Passing this as the full prompt means the model sees the reasoning block
    // already closed and generates the answer directly — no 10-minute think chain.
    // (--jinja + -rea off doesn't work for gemma-4-*-it-* variants.)
    const fullPrompt = `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n<think>\n\n</think>\n\n`;
    const promptPath = await writeTemp('tscriber-prompt-', fullPrompt);

    try {
      const args = [
        '-m', this.model,
        '-f', promptPath,
        '-no-cnv',             // disable auto conversation mode (we supply the full formatted prompt)
        '--no-display-prompt', // stdout = generation only
        '-ngl', '99',          // offload all layers to Metal
        '-c', String(this.ctxSize),
        '-n', String(this.maxTokens),
        '--temp', String(this.temp ?? 0),
      ];
      if (this.seed != null) args.push('-s', String(this.seed));

      const execOpts = { maxBuffer: 50 * 1024 * 1024 };
      if (signal) execOpts.signal = signal;
      const { stdout } = await execFileAsync(this.bin, args, execOpts);
      return cleanOutput(stdout);
    } catch (e) {
      const errText = (e.stderr || '') + (e.stdout || '');
      throw new Error(`llama-completion failed: ${e.message}\n${tail(errText, 1500)}`);
    } finally {
      await fsPromises.unlink(promptPath).catch(() => {});
    }
  }
}

async function writeTemp(prefix, content) {
  const name = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex') + '.txt');
  await fsPromises.writeFile(name, content, 'utf8');
  return name;
}

// validate checks that the output looks like a real summary, not a truncated reasoning chain.
function validate(s) {
  if (!s.includes('## Краткое резюме')) {
    throw new Error(
      'LLM output missing expected sections — likely truncated mid-reasoning. ' +
      'Try increasing llm_max_tokens in config (current default: ' + DEFAULT_MAX_TOKENS + ').'
    );
  }
  return s;
}

// cleanOutput strips the reasoning pass Gemma 4 always emits before the answer.
// It finds the last reasoning/answer delimiter and keeps everything after it,
// then scrubs any residual control tokens.
function cleanOutput(s) {
  s = s.trim();

  let cutAt = -1;
  for (const d of ['<channel|>', '<|channel|>final', '</think>', '<|end|>thought']) {
    const i = s.lastIndexOf(d);
    if (i >= 0 && i + d.length > cutAt) cutAt = i + d.length;
  }
  if (cutAt >= 0) s = s.slice(cutAt);

  s = s.replace(SPECIAL_TOKEN, '');
  s = s.replace(/\[end of text\]/g, '');
  return s.trim();
}

// splitChunks splits text on line boundaries into pieces at most maxChars long.
function splitChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let cur = '';

  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

module.exports = { Client, cleanOutput, splitChunks };
