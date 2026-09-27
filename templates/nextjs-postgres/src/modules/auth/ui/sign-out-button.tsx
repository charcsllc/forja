import { Button } from "@/components/ui/button";
import { authCopy } from "@/content/auth";
import { signOutAction } from "./actions";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button type="submit" variant="ghost" size="sm">
        {authCopy.signOut}
      </Button>
    </form>
  );
}
