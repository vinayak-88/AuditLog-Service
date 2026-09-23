import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "../../../../../lib/auth";
import { dashboardRequest } from "../../../../../lib/api";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

async function requireSession() {
  return getServerSession(authOptions);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const session = await requireSession();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  if (!isUuid(params.id)) {
    return NextResponse.json(
      { error: "A valid application ID is required" },
      { status: 400 },
    );
  }

  try {
    const response = await dashboardRequest(
      `/v1/apps/${encodeURIComponent(params.id)}`,
      {
        init: {
          method: "DELETE",
        },
      },
    );

    // The backend returns 204 with no body: preserve it without parsing JSON.
    if (response.status === 204) {
      return new Response(null, { status: 204 });
    }

    if (response.status === 401) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    if (response.status === 403) {
      return NextResponse.json(
        { error: "Application access denied" },
        { status: 403 },
      );
    }

    if (response.status === 404) {
      return NextResponse.json(
        { error: "Application not found" },
        { status: 404 },
      );
    }

    if (response.status === 429) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please try again shortly." },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: "Unable to deactivate application" },
      { status: 502 },
    );
  } catch (error) {
    console.error("Dashboard app deactivation proxy error", error);

    return NextResponse.json(
      { error: "Unable to reach the application service" },
      { status: 502 },
    );
  }
}
