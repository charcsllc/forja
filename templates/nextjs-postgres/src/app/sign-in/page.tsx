import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { authCopy } from "@/content/auth";
import { getCurrentUser } from "@/modules/auth";
import { SignInForm } from "@/modules/auth/ui/sign-in-form";

export const metadata: Metadata = { title: authCopy.title, robots: { index: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;

  return (
    <div className="mx-auto flex max-w-md px-4 py-16 sm:py-24">
      <Card className="w-full">
        <CardHeader>
          <h1 className="text-2xl font-semibold">{authCopy.title}</h1>
          <CardDescription>{authCopy.lead}</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm next={next} />
        </CardContent>
      </Card>
    </div>
  );
}
