import { shanghaiToday } from '../agent/time.js';
import { collectOpportunities, upsertOpportunityFacts } from './collect.js';

async function main(): Promise<void> {
  const now = new Date();
  const result = await collectOpportunities(now);
  const upserted = await upsertOpportunityFacts(
    result.facts,
    shanghaiToday(now),
  );
  console.log(
    JSON.stringify(
      {
        facts: result.facts.length,
        upserted,
        reposChecked: result.reposChecked,
        requests: result.requests,
        errors: result.errors,
      },
      null,
      2,
    ),
  );
  if (result.facts.length === 0 && result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
