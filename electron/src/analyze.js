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

const CHUNK_CHARS      = 16000;
const DEFAULT_CTX_SIZE = 16384;
const DEFAULT_MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `Ты — аналитик деловых встреч. На вход подаётся транскрипт встречи с указанием говорящих.
Отвечай строго на русском языке, по-деловому и без воды.
Сформируй результат в Markdown ровно с такими разделами:

## Краткое резюме
2–4 предложения о сути встречи.

## Ключевые решения
Маркированный список принятых решений. Если решений нет — напиши «—».

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
  constructor(bin, model, { ctxSize = DEFAULT_CTX_SIZE, maxTokens = DEFAULT_MAX_TOKENS, temp = null, seed = null } = {}) {
    this.bin       = bin;
    this.model     = model;
    this.ctxSize   = ctxSize;
    this.maxTokens = maxTokens;
    this.temp      = temp;
    this.seed      = seed;
  }

  async summarize(signal, transcript) {
    transcript = transcript.trim();
    if (!transcript) throw new Error('empty transcript');

    assertModelExists(this.model);

    const chunks = splitChunks(transcript, CHUNK_CHARS);

    if (chunks.length === 1) {
      return this._run(signal, SYSTEM_PROMPT, `Транскрипт:\n\n${chunks[0]}`);
    }

    // Map: summarise each chunk individually.
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      const part = await this._run(signal, SYSTEM_PROMPT,
        `Это часть ${i + 1} из ${chunks.length} транскрипта встречи.\n\nТранскрипт:\n\n${chunks[i]}`);
      partials.push(`### Часть ${i + 1}\n${part}`);
    }

    // Reduce: combine partial summaries.
    return this._run(signal, REDUCE_SYSTEM_PROMPT,
      `Промежуточные конспекты:\n\n${partials.join('\n\n')}`);
  }

  async _run(signal, system, user) {
    const sysPath = await writeTemp('tscriber-sys-', system);
    const usrPath = await writeTemp('tscriber-usr-', user);

    try {
      const args = [
        '-m', this.model,
        '--jinja',             // apply Gemma chat template
        '-sysf', sysPath,
        '-f', usrPath,
        '-st',                 // single turn, then exit
        '-rea', 'off',         // request no reasoning (Gemma 4 ignores it; cleanOutput handles it)
        '--no-display-prompt', // stdout = generation only
        '-ngl', '99',          // offload all layers to Metal
        '-c', String(this.ctxSize),
        '-n', String(this.maxTokens),
        '--temp', String(this.temp ?? 0.2),
      ];
      if (this.seed != null) args.push('-s', String(this.seed));

      const execOpts = { maxBuffer: 50 * 1024 * 1024 };
      if (signal) execOpts.signal = signal; // Node rejects a null signal
      const { stdout } = await execFileAsync(this.bin, args, execOpts);
      return cleanOutput(stdout);
    } catch (e) {
      const errText = (e.stderr || '') + (e.stdout || '');
      throw new Error(`llama-completion failed: ${e.message}\n${tail(errText, 1500)}`);
    } finally {
      await fsPromises.unlink(sysPath).catch(() => {});
      await fsPromises.unlink(usrPath).catch(() => {});
    }
  }
}

async function writeTemp(prefix, content) {
  const name = path.join(os.tmpdir(), prefix + crypto.randomBytes(8).toString('hex') + '.txt');
  await fsPromises.writeFile(name, content, 'utf8');
  return name;
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
