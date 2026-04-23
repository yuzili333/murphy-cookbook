export declare function isOpenAIConfigured(): boolean;
export declare function transcribeAudioWithOpenAI(file: {
    buffer: Buffer;
    filename: string;
    mimetype: string;
}): Promise<string>;
