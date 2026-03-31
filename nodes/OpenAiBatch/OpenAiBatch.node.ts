import {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

interface BatchRequest {
	custom_id: string;
	method: string;
	url: string;
	body: Record<string, unknown>;
}

interface BatchResponse {
	id: string;
	custom_id: string;
	response: {
		status_code: number;
		request_id: string;
		body: Record<string, unknown>;
	};
	error: null | {
		code: string;
		message: string;
	};
}

interface BatchStatus {
	id: string;
	object: string;
	endpoint: string;
	errors: null | {
		object: string;
		data: Array<{
			code: string;
			message: string;
			param: string | null;
			line: number | null;
		}>;
	};
	input_file_id: string;
	completion_window: string;
	status: 'validating' | 'failed' | 'in_progress' | 'finalizing' | 'completed' | 'expired' | 'cancelling' | 'cancelled';
	output_file_id: string | null;
	error_file_id: string | null;
	created_at: number;
	in_progress_at: number | null;
	expires_at: number | null;
	finalizing_at: number | null;
	completed_at: number | null;
	failed_at: number | null;
	expired_at: number | null;
	cancelling_at: number | null;
	cancelled_at: number | null;
	request_counts: {
		total: number;
		completed: number;
		failed: number;
	};
	metadata: Record<string, string> | null;
}

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function getHttpStatusCode(error: unknown): number | null {
	if (!error || typeof error !== 'object') return null;
	const err = error as Record<string, unknown>;
	for (const key of ['httpCode', 'statusCode'] as const) {
		const val = err[key];
		if (typeof val === 'number') return val;
		if (typeof val === 'string') { const n = parseInt(val, 10); if (n) return n; }
	}
	return null;
}

async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries = 3,
	baseDelay = 1000,
	maxDelay = 30000,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			const statusCode = getHttpStatusCode(error);
			if (attempt >= maxRetries || !statusCode || !RETRYABLE_STATUS_CODES.has(statusCode)) {
				throw error;
			}
			// Exponential backoff with jitter (±25%)
			const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay) * (0.75 + Math.random() * 0.5);
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
	throw lastError;
}

export class OpenAiBatch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenAI Batch',
		name: 'openAiBatch',
		icon: 'file:openai.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Execute batch requests to OpenAI API',
		defaults: {
			name: 'OpenAI Batch',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'openAiApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Chat Completion',
						value: 'chatCompletion',
						description: 'Create chat completions in batch',
						action: 'Create chat completions in batch',
					},
					{
						name: 'Embeddings',
						value: 'embeddings',
						description: 'Create embeddings in batch',
						action: 'Create embeddings in batch',
					},
				],
				default: 'chatCompletion',
			},
			// Chat Completion Options
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
				typeOptions: {
					loadOptionsMethod: 'getChatModels',
				},
				default: 'gpt-4o-mini',
				description: 'The model to use for chat completion',
			},
			{
				displayName: 'Input Mode',
				name: 'inputMode',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
					},
				},
				options: [
					{
						name: 'Simple',
						value: 'simple',
						description: 'Just provide a prompt (user message)',
					},
					{
						name: 'Advanced',
						value: 'advanced',
						description: 'Configure full message array with roles',
					},
				],
				default: 'simple',
				description: 'How to provide input messages',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
						inputMode: ['simple'],
					},
				},
				default: '',
				description: 'The prompt to send. Use expressions like {{ $json.prompt }} to reference input data.',
			},
			{
				displayName: 'System Prompt',
				name: 'systemPrompt',
				type: 'string',
				typeOptions: {
					rows: 2,
				},
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
						inputMode: ['simple'],
					},
				},
				default: '',
				description: 'Optional system prompt to set the behavior of the assistant',
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				displayOptions: {
					show: {
						operation: ['chatCompletion'],
						inputMode: ['advanced'],
					},
				},
				default: {},
				placeholder: 'Add Message',
				options: [
					{
						name: 'messagesValues',
						displayName: 'Message',
						values: [
							{
								displayName: 'Role',
								name: 'role',
								type: 'options',
								options: [
									{
										name: 'System',
										value: 'system',
									},
									{
										name: 'User',
										value: 'user',
									},
									{
										name: 'Assistant',
										value: 'assistant',
									},
								],
								default: 'user',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: {
									rows: 4,
								},
								default: '',
								description: 'The content of the message. Use expressions like {{ $json.text }} to reference input data.',
							},
						],
					},
				],
				description: 'The messages for the chat completion',
			},
			// Embeddings Options
			{
				displayName: 'Embedding Model',
				name: 'embeddingModel',
				type: 'options',
				displayOptions: {
					show: {
						operation: ['embeddings'],
					},
				},
				typeOptions: {
					loadOptionsMethod: 'getEmbeddingModels',
				},
				default: 'text-embedding-3-small',
				description: 'The model to use for embeddings',
			},
			{
				displayName: 'Input Text',
				name: 'inputText',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				displayOptions: {
					show: {
						operation: ['embeddings'],
					},
				},
				default: '',
				description: 'The text to embed. Use expressions like {{ $json.text }} to reference input data.',
			},
			// Common Options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Max Tokens',
						name: 'maxTokens',
						type: 'number',
						displayOptions: {
							show: {
								'/operation': ['chatCompletion'],
							},
						},
						default: 1000,
						description: 'Maximum number of tokens to generate',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						displayOptions: {
							show: {
								'/operation': ['chatCompletion'],
							},
						},
						typeOptions: {
							minValue: 0,
							maxValue: 2,
							numberPrecision: 1,
						},
						default: 1,
						description: 'Controls randomness. Lower is more deterministic.',
					},
					{
						displayName: 'Max Batch Size',
						name: 'maxBatchSize',
						type: 'number',
						default: 100,
						description: 'Maximum number of requests per batch. Larger inputs will be split into multiple batches.',
					},
					{
						displayName: 'Polling Interval (Seconds)',
						name: 'pollingInterval',
						type: 'number',
						default: 30,
						description: 'How often to check batch status',
					},
					{
						displayName: 'Timeout (Minutes)',
						name: 'timeout',
						type: 'number',
						default: 1440,
						description: 'Maximum time to wait for batch completion (default 24 hours)',
					},
					{
						displayName: 'Fallback Deadline (Minutes)',
						name: 'fallbackDeadline',
						type: 'number',
						default: 0,
						description: 'If set, cancel incomplete batches after this time and run remaining requests synchronously. 0 = disabled.',
					},
					{
						displayName: 'Metadata',
						name: 'metadata',
						type: 'json',
						default: '{}',
						description: 'Optional metadata to attach to the batch',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getChatModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'openAiApi',
						{
							method: 'GET',
							url: 'https://api.openai.com/v1/models',
						},
					) as { data: Array<{ id: string; owned_by: string }> };

					const chatModels = response.data
						.filter((model) => {
							const id = model.id.toLowerCase();
							return (
								id.includes('gpt') ||
								id.includes('o1') ||
								id.includes('o3') ||
								id.includes('chatgpt')
							) && !id.includes('instruct') && !id.includes('audio') && !id.includes('realtime');
						})
						.map((model) => ({
							name: model.id,
							value: model.id,
						}))
						.sort((a, b) => a.name.localeCompare(b.name));

					return chatModels.length > 0 ? chatModels : [{ name: 'gpt-4o-mini', value: 'gpt-4o-mini' }];
				} catch (error) {
					return [
						{ name: 'gpt-4o-mini', value: 'gpt-4o-mini' },
						{ name: 'gpt-4o', value: 'gpt-4o' },
						{ name: 'gpt-4-turbo', value: 'gpt-4-turbo' },
					];
				}
			},

			async getEmbeddingModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const response = await this.helpers.httpRequestWithAuthentication.call(
						this,
						'openAiApi',
						{
							method: 'GET',
							url: 'https://api.openai.com/v1/models',
						},
					) as { data: Array<{ id: string; owned_by: string }> };

					const embeddingModels = response.data
						.filter((model) => model.id.toLowerCase().includes('embedding'))
						.map((model) => ({
							name: model.id,
							value: model.id,
						}))
						.sort((a, b) => a.name.localeCompare(b.name));

					return embeddingModels.length > 0 ? embeddingModels : [{ name: 'text-embedding-3-small', value: 'text-embedding-3-small' }];
				} catch (error) {
					return [
						{ name: 'text-embedding-3-small', value: 'text-embedding-3-small' },
						{ name: 'text-embedding-3-large', value: 'text-embedding-3-large' },
					];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const options = this.getNodeParameter('options', 0, {}) as {
			maxTokens?: number;
			temperature?: number;
			maxBatchSize?: number;
			pollingInterval?: number;
			timeout?: number;
			fallbackDeadline?: number;
			metadata?: string;
		};

		const maxBatchSize = options.maxBatchSize || 100;
		const pollingInterval = (options.pollingInterval || 30) * 1000;
		const timeout = (options.timeout || 1440) * 60 * 1000;
		const fallbackDeadline = options.fallbackDeadline ? options.fallbackDeadline * 60 * 1000 : 0;

		const credentials = await this.getCredentials('openAiApi');

		// Build batch requests from input items
		const batchRequests: BatchRequest[] = [];
		const resultMap = new Map<string, BatchResponse>();
		const skippedItems = new Set<number>();

		for (let i = 0; i < items.length; i++) {
			let request: BatchRequest;
			const customId = `request-${i}`;

			if (operation === 'chatCompletion') {
				const model = this.getNodeParameter('model', i) as string;
				const inputMode = this.getNodeParameter('inputMode', i, 'simple') as string;

				let messages: Array<{ role: string; content: string }>;
				let isEmpty = false;

				if (inputMode === 'simple') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					const systemPrompt = this.getNodeParameter('systemPrompt', i, '') as string;

					// Check for empty prompt
					if (!prompt || !prompt.trim()) {
						isEmpty = true;
					}

					messages = [];
					if (systemPrompt) {
						messages.push({ role: 'system', content: systemPrompt });
					}
					messages.push({ role: 'user', content: prompt || '' });
				} else {
					const messagesParam = this.getNodeParameter('messages.messagesValues', i, []) as Array<{
						role: string;
						content: string;
					}>;

					// Check for empty messages
					if (!messagesParam || messagesParam.length === 0) {
						isEmpty = true;
					}

					messages = messagesParam.map((msg) => ({
						role: msg.role,
						content: msg.content,
					}));
				}

				// Skip empty prompts and store empty response
				if (isEmpty) {
					skippedItems.add(i);
					resultMap.set(customId, {
						id: `empty-${customId}`,
						custom_id: customId,
						response: {
							status_code: 200,
							request_id: `empty-${customId}`,
							body: {
								choices: [{
									message: { content: '', role: 'assistant' },
									index: 0,
									finish_reason: 'skipped',
								}],
							},
						},
						error: null,
					});
					continue;
				}

				const body: Record<string, unknown> = {
					model,
					messages,
				};

				if (options.maxTokens) {
					body.max_tokens = options.maxTokens;
				}
				if (options.temperature !== undefined) {
					body.temperature = options.temperature;
				}

				request = {
					custom_id: customId,
					method: 'POST',
					url: '/v1/chat/completions',
					body,
				};
			} else if (operation === 'embeddings') {
				const model = this.getNodeParameter('embeddingModel', i) as string;
				const inputText = this.getNodeParameter('inputText', i) as string;

				// Skip empty input and store empty response
				if (!inputText || !inputText.trim()) {
					skippedItems.add(i);
					resultMap.set(customId, {
						id: `empty-${customId}`,
						custom_id: customId,
						response: {
							status_code: 200,
							request_id: `empty-${customId}`,
							body: {
								data: [{
									embedding: [],
									index: 0,
								}],
							},
						},
						error: null,
					});
					continue;
				}

				request = {
					custom_id: customId,
					method: 'POST',
					url: '/v1/embeddings',
					body: {
						model,
						input: inputText,
					},
				};
			} else {
				throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`);
			}

			batchRequests.push(request);
		}

		// Parse metadata once
		let metadata: Record<string, string> | undefined;
		try {
			if (options.metadata) {
				metadata = JSON.parse(options.metadata);
			}
		} catch (e) {
			throw new NodeOperationError(this.getNode(), 'Invalid metadata JSON');
		}

		// Track batches: batchId -> { customIds, status, outputFileId }
		interface BatchInfo {
			batchId: string;
			customIds: string[];
			status: BatchStatus['status'];
			outputFileId: string | null;
		}
		const batches: BatchInfo[] = [];

		// Create batches using index-based chunking (no intermediate chunk arrays)
		for (let chunkStart = 0; chunkStart < batchRequests.length; chunkStart += maxBatchSize) {
			const chunkEnd = Math.min(chunkStart + maxBatchSize, batchRequests.length);

			// Build JSONL buffer directly — avoids intermediate string array and joined string
			const buffers: Buffer[] = [];
			const customIds: string[] = [];
			for (let j = chunkStart; j < chunkEnd; j++) {
				if (j > chunkStart) buffers.push(Buffer.from('\n'));
				buffers.push(Buffer.from(JSON.stringify(batchRequests[j])));
				customIds.push(batchRequests[j].custom_id);
			}
			const jsonlBuffer = Buffer.concat(buffers);
			buffers.length = 0; // release individual buffers

			const chunkIndex = Math.floor(chunkStart / maxBatchSize);

			// Upload JSONL file
			const uploadResponse = await retryWithBackoff(() => this.helpers.request({
				method: 'POST',
				url: 'https://api.openai.com/v1/files',
				headers: {
					Authorization: `Bearer ${credentials.apiKey}`,
				},
				formData: {
					purpose: 'batch',
					file: {
						value: jsonlBuffer,
						options: {
							filename: `batch_requests_${chunkIndex}.jsonl`,
							contentType: 'application/jsonl',
						},
					},
				},
				json: true,
			}));

			const inputFileId = uploadResponse.id;

			// Create batch
			const batchCreateBody: Record<string, unknown> = {
				input_file_id: inputFileId,
				endpoint: operation === 'chatCompletion' ? '/v1/chat/completions' : '/v1/embeddings',
				completion_window: '24h',
			};

			if (metadata && Object.keys(metadata).length > 0) {
				batchCreateBody.metadata = { ...metadata, chunk: String(chunkIndex) };
			}

			const batchResponse = await retryWithBackoff(() => this.helpers.httpRequestWithAuthentication.call(
				this,
				'openAiApi',
				{
					method: 'POST',
					url: 'https://api.openai.com/v1/batches',
					headers: {
						'Content-Type': 'application/json',
					},
					body: batchCreateBody,
				},
			)) as BatchStatus;

			batches.push({
				batchId: batchResponse.id,
				customIds,
				status: batchResponse.status,
				outputFileId: null,
			});
		}

		// Build lookup map for O(1) fallback access, then release the array
		const requestLookup = fallbackDeadline > 0
			? new Map(batchRequests.map(r => [r.custom_id, r]))
			: null;
		batchRequests.length = 0;

		// Poll for batch completion
		const startTime = Date.now();
		const completedBatches = new Set<string>();
		let deadlineReached = false;

		while (completedBatches.size < batches.length) {
			await new Promise((resolve) => setTimeout(resolve, pollingInterval));

			const elapsed = Date.now() - startTime;

			// Check hard timeout
			if (elapsed > timeout) {
				throw new NodeOperationError(
					this.getNode(),
					`Batch processing timed out after ${options.timeout || 1440} minutes.`,
				);
			}

			// Check fallback deadline
			if (fallbackDeadline > 0 && elapsed > fallbackDeadline && !deadlineReached) {
				deadlineReached = true;
				break;
			}

			// Poll each incomplete batch
			for (const batch of batches) {
				if (completedBatches.has(batch.batchId)) continue;

				const batchStatus = await retryWithBackoff(() => this.helpers.httpRequestWithAuthentication.call(
					this,
					'openAiApi',
					{
						method: 'GET',
						url: `https://api.openai.com/v1/batches/${batch.batchId}`,
					},
				)) as BatchStatus;

				batch.status = batchStatus.status;
				batch.outputFileId = batchStatus.output_file_id;

				if (batchStatus.status === 'completed') {
					completedBatches.add(batch.batchId);

					// Download results for this batch
					if (batchStatus.output_file_id) {
						const outputFileResponse = await retryWithBackoff(() => this.helpers.httpRequestWithAuthentication.call(
							this,
							'openAiApi',
							{
								method: 'GET',
								url: `https://api.openai.com/v1/files/${batchStatus.output_file_id}/content`,
								returnFullResponse: true,
								json: false,
							},
						));

						// Extract the content string from the response
						let outputContent: string;
						if (typeof outputFileResponse === 'string') {
							outputContent = outputFileResponse;
						} else if (outputFileResponse && typeof outputFileResponse.body === 'string') {
							outputContent = outputFileResponse.body;
						} else if (outputFileResponse && outputFileResponse.body && typeof outputFileResponse.body === 'object') {
							// If body is a Buffer, convert to string
							if (Buffer.isBuffer(outputFileResponse.body)) {
								outputContent = outputFileResponse.body.toString('utf-8');
							} else {
								// Last resort: stringify (shouldn't happen for JSONL)
								outputContent = JSON.stringify(outputFileResponse.body);
							}
						} else {
							throw new NodeOperationError(
								this.getNode(),
								`Unexpected response format when downloading batch results. Response type: ${typeof outputFileResponse}`,
							);
						}

						if (!outputContent || !outputContent.trim()) {
							throw new NodeOperationError(
								this.getNode(),
								'Batch output file was empty',
							);
						}

						const outputLines = outputContent.trim().split('\n');
						for (let lineIndex = 0; lineIndex < outputLines.length; lineIndex++) {
							let result: BatchResponse;
							try {
								result = JSON.parse(outputLines[lineIndex]);
							} catch (e) {
								throw new NodeOperationError(
									this.getNode(),
									`Failed to parse batch result line ${lineIndex + 1}: ${e instanceof Error ? e.message : 'Unknown error'}. Content: ${outputLines[lineIndex].substring(0, 200)}`,
								);
							}
							resultMap.set(result.custom_id, result);
						}
					}
				} else if (batchStatus.status === 'failed') {
					const errorMessages = batchStatus.errors?.data?.map(e => e.message).join(', ') || 'Unknown error';
					throw new NodeApiError(this.getNode(), {}, {
						message: `Batch processing failed: ${errorMessages}`,
						description: `Batch ID: ${batch.batchId}`,
					});
				} else if (batchStatus.status === 'expired' || batchStatus.status === 'cancelled') {
					completedBatches.add(batch.batchId);
					// These requests will be handled as missing results or fallback
				}
			}
		}

		// Handle fallback if deadline was reached
		if (deadlineReached) {
			// Cancel incomplete batches
			for (const batch of batches) {
				if (!completedBatches.has(batch.batchId) && !['completed', 'failed', 'expired', 'cancelled'].includes(batch.status)) {
					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'openAiApi',
							{
								method: 'POST',
								url: `https://api.openai.com/v1/batches/${batch.batchId}/cancel`,
							},
						);
					} catch (e) {
						// Ignore cancellation errors
					}
				}
			}

			// Find requests that didn't complete
			const incompleteCustomIds: string[] = [];
			for (const batch of batches) {
				for (const customId of batch.customIds) {
					if (!resultMap.has(customId)) {
						incompleteCustomIds.push(customId);
					}
				}
			}

			// Run incomplete requests in parallel
			const syncPromises = incompleteCustomIds.map(async (customId) => {
				const originalRequest = requestLookup!.get(customId);
				if (!originalRequest) return;

				try {
					const syncResponse = await retryWithBackoff(() => this.helpers.httpRequestWithAuthentication.call(
						this,
						'openAiApi',
						{
							method: 'POST',
							url: `https://api.openai.com${originalRequest.url}`,
							headers: {
								'Content-Type': 'application/json',
							},
							body: originalRequest.body,
						},
					)) as Record<string, unknown>;

					// Convert sync response to batch response format
					resultMap.set(customId, {
						id: `sync-${customId}`,
						custom_id: customId,
						response: {
							status_code: 200,
							request_id: `sync-${customId}`,
							body: syncResponse,
						},
						error: null,
					});
				} catch (error) {
					// Build detailed error message for debugging
					let errorMessage = error instanceof Error ? error.message : 'Unknown error during synchronous fallback';

					// Capture additional error properties from n8n errors
					const debugInfo: string[] = [];
					if (error && typeof error === 'object') {
						const err = error as Record<string, unknown>;
						if (err.httpCode) debugInfo.push(`HTTP ${err.httpCode}`);
						if (err.description) debugInfo.push(`Description: ${err.description}`);
						if (err.cause) debugInfo.push(`Cause: ${err.cause}`);
					}

					// Include request info for debugging
					debugInfo.push(`URL: https://api.openai.com${originalRequest.url}`);
					debugInfo.push(`Body: ${JSON.stringify(originalRequest.body).substring(0, 500)}`);

					if (debugInfo.length > 0) {
						errorMessage += ' | Debug: ' + debugInfo.join(' | ');
					}

					resultMap.set(customId, {
						id: `sync-${customId}`,
						custom_id: customId,
						response: {
							status_code: 500,
							request_id: `sync-${customId}`,
							body: {},
						},
						error: {
							code: 'sync_error',
							message: errorMessage,
						},
					});
				}
			});

			await Promise.all(syncPromises);
		}

		// Create output items
		const returnData: INodeExecutionData[] = [];
		const batchIds = batches.map((b) => b.batchId).join(',');

		for (let i = 0; i < items.length; i++) {
			const customId = `request-${i}`;
			const result = resultMap.get(customId);

			if (result) {
				if (result.error) {
					returnData.push({
						json: {
							error: result.error,
							batchId: batchIds,
							customId,
							fallback: result.id.startsWith('sync-'),
						},
						pairedItem: { item: i },
					});
				} else {
					// Validate response structure
					if (!result.response || !result.response.body) {
						returnData.push({
							json: {
									error: {
									message: 'Invalid response structure: missing response or body',
									rawResult: result,
								},
								batchId: batchIds,
								customId,
								fallback: result.id?.startsWith('sync-') || false,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					const responseBody = result.response.body;

					if (operation === 'chatCompletion') {
						const choices = responseBody.choices as Array<{
							message: { content: string; role: string };
							index: number;
							finish_reason: string;
						}> | undefined;

						if (!choices || !Array.isArray(choices) || choices.length === 0) {
							returnData.push({
								json: {
											error: {
										message: 'No choices in response',
										statusCode: result.response.status_code,
									},
									fullResponse: responseBody,
									batchId: batchIds,
									customId,
									fallback: result.id.startsWith('sync-'),
								},
								pairedItem: { item: i },
							});
						} else {
							returnData.push({
								json: {
											response: choices[0]?.message?.content || '',
									fullResponse: responseBody,
									batchId: batchIds,
									customId,
									fallback: result.id.startsWith('sync-'),
								},
								pairedItem: { item: i },
							});
						}
					} else if (operation === 'embeddings') {
						const data = responseBody.data as Array<{
							embedding: number[];
							index: number;
						}> | undefined;

						if (!data || !Array.isArray(data) || data.length === 0) {
							returnData.push({
								json: {
											error: {
										message: 'No embedding data in response',
										statusCode: result.response.status_code,
									},
									fullResponse: responseBody,
									batchId: batchIds,
									customId,
									fallback: result.id.startsWith('sync-'),
								},
								pairedItem: { item: i },
							});
						} else {
							returnData.push({
								json: {
											embedding: data[0]?.embedding || [],
									fullResponse: responseBody,
									batchId: batchIds,
									customId,
									fallback: result.id.startsWith('sync-'),
								},
								pairedItem: { item: i },
							});
						}
					} else {
						// Fallback for unknown operation (shouldn't happen)
						returnData.push({
							json: {
									error: { message: `Unknown operation: ${operation}` },
								fullResponse: responseBody,
								batchId: batchIds,
								customId,
								fallback: result.id.startsWith('sync-'),
							},
							pairedItem: { item: i },
						});
					}
				}
			} else {
				returnData.push({
					json: {
						...items[i].json,
						error: {
							message: 'No result found for this request',
							debug: {
								expectedCustomId: customId,
								resultMapSize: resultMap.size,
								sampleCustomIds: Array.from(resultMap.keys()).slice(0, 10),
								batchStatuses: batches.map(b => ({ id: b.batchId, status: b.status })),
							},
						},
						batchId: batchIds,
						customId,
						fallback: false,
					},
					pairedItem: { item: i },
				});
			}
		}

		return [returnData];
	}
}
