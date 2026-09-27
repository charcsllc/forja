import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/content/site";
import { getCurrentUser } from "@/modules/auth";
import { SignOutButton } from "@/modules/auth/ui/sign-out-button";

export async function SiteHeader() {
  const user = await getCurrentUser().catch(() => null);
  return (
    <header className="border-b border-border">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="font-display text-lg font-semibold">
          {site.name}
        </Link>
        {user ? (
          <SignOutButton />
        ) : (
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            {site.nav.signIn}
          </Link>
        )}
      </nav>
    </header>
  );
}
