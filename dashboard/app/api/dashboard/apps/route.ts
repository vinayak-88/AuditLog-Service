import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "../../../../lib/auth";
import { dashboardRequest } from "../../../../lib/api";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

type CreateAppResponse = {
  success: boolean;
  data?: {
    id: string;
    name: string;
    description: string | null;
    apiKey: string;
    createdAt: string;
  };
};

async function requireSession() {
  return getServerSession(authOptions);
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  let body: { name?: unknown; description?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; description?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description.trim()
      : undefined;

  if (!name || name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: "An application name between 1 and 100 characters is required" },
      { status: 400 },
    );
  }

  if (
    body.description !== undefined &&
    (typeof body.description !== "string" ||
      body.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return NextResponse.json(
      { error: "Description must be at most 500 characters" },
      { status: 400 },
    );
  }

  try {
    const response = await dashboardRequest("/v1/apps", {
      init: {
        method: "POST",
        body: JSON.stringify({ name, description }),
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return NextResponse.json(
          { error: "Authentication required" },
          { status: 401 },
        );
      }

      if (response.status === 429) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Please try again shortly." },
          { status: 429 },
        );
      }

      if (response.status === 400) {
        try {
          const backend = (await response.json()) as {
            error?: { message?: string };
          };
          return NextResponse.json(
            { error: backend.error?.message ?? "Invalid application details" },
            { status: 400 },
          );
        } catch {
          return NextResponse.json(
            { error: "Invalid application details" },
            { status: 400 },
          );
        }
      }

      return NextResponse.json(
        { error: "Unable to create application" },
        { status: 502 },
      );
    }

    const result = (await response.json()) as CreateAppResponse;
    return NextResponse.json(result, { status: response.status });
  } catch (error) {
    console.error("Dashboard app creation proxy error", error);

    return NextResponse.json(
      { error: "Unable to reach the application service" },
      { status: 502 },
    );
  }
}
