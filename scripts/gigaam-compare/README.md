# GigaAM-v3 vs Whisper — прототип

Сравнение распознавания GigaAM-v3 (Сбер, MIT) с текущим whisper.cpp large-v3-turbo на записанных сессиях. Эталонной расшифровки нет, поэтому сравниваются взаимное расхождение, повторы/петли, английские термины и крупнейшие расхождения после выравнивания слов.

## Окружение

GigaAM 0.2.0 из PyPI тянет `torch<=2.5.1`, которого нет под Python 3.14 — ставим из исходников с ослабленными пинами onnx:

```bash
python3 -m venv .venv
git clone --depth 1 https://github.com/salute-developers/GigaAM.git
sed -i '' -e 's/"onnx==1.19.\*"/"onnx"/' -e 's/"onnxruntime==1.23.\*"/"onnxruntime"/' GigaAM/pyproject.toml
.venv/bin/pip install -e "./GigaAM[torch]" silero-vad jiwer
```

## Запуск

```bash
# GigaAM: PCM дорожки сессии → сегменты с пословными таймкодами (модель ~430 МБ скачается в ~/.cache/gigaam)
.venv/bin/python run_gigaam.py ~/.tscriber/sessions/<id>/tab.pcm out/<id>.gigaam.json [--model v3_e2e_ctc]

# Сравнение: whisper-cli JSON или transcript.tab.json сессии против вывода GigaAM
.venv/bin/python compare.py ~/.tscriber/sessions/<id>/transcript.tab.json out/<id>.gigaam.json
```

Длинное аудио режется Silero VAD на куски ≤20 с (`.transcribe` в GigaAM ограничен ~25 с; встроенный `transcribe_longform` требует pyannote и HF-токен).
