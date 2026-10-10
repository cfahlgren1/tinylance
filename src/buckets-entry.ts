// tinylance/buckets: sources for S3, S3-compatible stores and Google Cloud Storage, with options
// for private buckets. s3:// and gs:// URIs passed to lanceOpen load this automatically.
export { gcsSource, s3Source } from './buckets.ts'

export type { GcsSourceOptions, S3SourceOptions, Signer } from './buckets.ts'

export { sigv4 } from './sigv4.ts'

export type { AwsCredentials } from './sigv4.ts'
