import 'dotenv/config';

const API_URL = process.env.API_URL!;
const API_KEY = process.env.MOCK_API_KEY;

async function main() {
  if (!API_KEY) {
    throw new Error('Set MOCK_API_KEY to an app API key before running the producer.');
  }

  const actions = ['invoice.created', 'invoice.updated', 'invoice.deleted', 'login.succeeded'];

  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        actorId: `user_${(index % 3) + 1}`,
        actorType: index % 5 === 0 ? 'admin' : 'user',
        action: actions[index % actions.length],
        resourceId: `invoice_${(index % 4) + 1}`,
        resourceType: 'invoice',
        metadata: { source: 'producer', index }
      })
    });

    const body = await response.json();
    console.log(response.status, body);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
