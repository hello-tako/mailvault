export interface IngestDlqOptions {
  replay: boolean;
  limit: number;
  help: boolean;
  account_id?: string;
  dlq_id?: string;
  queue_id?: string;
  database_id?: string;
  bucket?: string;
}

export function parseOptions(argv: string[]): IngestDlqOptions;

export function classifyIngest(input: {
  job: { messageId: string; rawKey: string; parsedKey: string } | null;
  row: {
    id: string;
    raw_r2_key: string;
    parsed_r2_key: string;
    attachment_count: number;
    ingest_status: string | null;
    attachment_keys: string[];
  } | null;
  attachmentKeys: string[] | null;
  indexedRows: number;
  objectsPresent: boolean;
  stagedValid: boolean;
  canonicalComplete?: boolean;
  canonicalReplayable?: boolean;
}): { state: string; replayable: boolean };

export function run(
  options: IngestDlqOptions,
  dependencies?: {
    token?: string;
    api?: (
      token: string,
      url: string,
      init?: { method?: string; body?: string },
    ) => Promise<unknown>;
    readR2?: (key: string, capture: boolean) => string | boolean | null;
    log?: (line: string) => void;
  },
): Promise<void>;
