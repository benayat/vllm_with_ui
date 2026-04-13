export function toStartModelRequest({ modelName, config, gpuId }) {
    return { model_name: modelName, config, gpu_id: gpuId };
}

export function toSimpleGenerationRequest({ modelName, useOffline, prompts, sampling, includeMetadata, cleanupModelAfterJob, preProcessor, postProcessor }) {
    if (useOffline) {
        return {
            model_name: modelName,
            type: 'generate',
            prompts,
            sampling,
            include_metadata: includeMetadata,
            cleanup_model_after_job: cleanupModelAfterJob,
            pre_processor: preProcessor,
            post_processor: postProcessor,
        };
    }
    return {
        model_name: modelName,
        prompts,
        sampling,
        include_metadata: includeMetadata,
        pre_processor: preProcessor,
        post_processor: postProcessor,
    };
}

export function toChatGenerationRequest({ modelName, useOffline, prompts, sampling, outField, includeMetadata, cleanupModelAfterJob, preProcessor, postProcessor }) {
    if (useOffline) {
        return {
            model_name: modelName,
            type: 'chat',
            prompts,
            sampling,
            output_field: outField,
            include_metadata: includeMetadata,
            cleanup_model_after_job: cleanupModelAfterJob,
            pre_processor: preProcessor,
            post_processor: postProcessor,
        };
    }
    return {
        model_name: modelName,
        prompts,
        sampling,
        output_field: outField,
        include_metadata: includeMetadata,
        pre_processor: preProcessor,
        post_processor: postProcessor,
    };
}
