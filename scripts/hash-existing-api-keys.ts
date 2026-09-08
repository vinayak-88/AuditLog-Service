import 'dotenv/config';
import prisma from '../src/config/db';
import { hashApiKey } from '../src/services/apiKey';

async function main() {
  const apps = await prisma.app.findMany({ select: { id: true, apiKey: true } });
  let migrated = 0;

  for (const app of apps) {
    if (/^[0-9a-f]{64}$/.test(app.apiKey)) continue;

    await prisma.app.update({
      where: { id: app.id },
      data: { apiKey: hashApiKey(app.apiKey) }
    });
    migrated += 1;
  }

  console.log(`Migrated ${migrated} API key(s) to HMAC digests.`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
