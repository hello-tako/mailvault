/** Pending message/alias cleanup hides content while durable jobs retain its pointers. */
export function visibleMessageSql(alias = "m"): string {
  return `${alias}.deletion_pending = 0 AND NOT EXISTS (
    SELECT 1 FROM deletion_jobs visibility_job
    WHERE visibility_job.job_type = 'ALIAS_PURGE' AND visibility_job.alias_id = ${alias}.alias_id
      AND visibility_job.state <> 'DONE'
  )`;
}
