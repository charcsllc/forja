import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { site } from "@/content/site";
import { getCurrentUser } from "@/modules/auth";

export default async function HomePage() {
  const user = await getCurrentUser().catch(() => null);
  const copy = site.home;

  return (
    <div className="mx-auto grid max-w-5xl gap-16 px-4 py-16 sm:px-6 sm:py-24">
      <section className="grid max-w-2xl gap-6">
        <p className="text-sm font-medium text-accent">{copy.eyebrow}</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{copy.title}</h1>
        <p className="text-lg text-muted-foreground">{copy.lead}</p>
        {user ? (
          <p className="text-sm text-muted-foreground">
            {copy.signedInAs} <span className="font-medium text-foreground">{user.email}</span>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {user ? null : (
            <Link href="/sign-in" className={buttonVariants({ size: "lg" })}>
              {copy.primaryCta}
            </Link>
          )}
          <Link href="/api/health" className={buttonVariants({ variant: "outline", size: "lg" })} prefetch={false}>
            {copy.secondaryCta}
          </Link>
        </div>
      </section>

      <section aria-label="Features" className="grid gap-4 sm:grid-cols-3">
        {copy.features.map((feature) => (
          <Card key={feature.title}>
            <CardHeader>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
    </div>
  );
}
