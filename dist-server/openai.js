const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe';
export function isOpenAIConfigured() {
    return Boolean(process.env.OPENAI_API_KEY);
}
export async function transcribeAudioWithOpenAI(file) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not configured.');
    }
    const form = new FormData();
    const blob = new Blob([file.buffer], { type: file.mimetype });
    form.append('file', blob, file.filename);
    form.append('model', TRANSCRIBE_MODEL);
    form.append('language', 'zh');
    form.append('prompt', '这是儿童烹饪场景中的食材描述，请尽量准确识别常见食材名称。');
    const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        body: form,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI transcription failed: ${text}`);
    }
    const payload = (await response.json());
    return payload.text?.trim() ?? '';
}
