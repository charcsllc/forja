import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { site } from "@/content/site";

export default function NotFound() {
  return (
    <div className="mx-auto grid max-w-xl gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">{site.notFound.title}</h1>
      <p className="text-muted-foreground">{site.notFound.body}</p>
      <div>
        <Link href="/" className={buttonVariants()}>
          {site.notFound.cta}
        </Link>
      </div>
    </div>
  );
}
