/** Site-wide copy and metadata. Components never hard-code strings; they read them from src/content. */
export const site = {
  name: "App",
  tagline: "A full-stack Next.js starter",
  description: "A production-ready Next.js app with Postgres, authentication and background jobs.",
  locale: "en",
  nav: {
    home: "Home",
    signIn: "Sign in",
    skipToContent: "Skip to content",
  },
  home: {
    eyebrow: "Ready to build",
    title: "Your app starts here",
    lead: "Next.js 16, Postgres, authentication, storage, email and background jobs, wired and tested. Describe what you want and it grows from this page.",
    primaryCta: "Sign in",
    secondaryCta: "Health check",
    signedInAs: "Signed in as",
    features: [
      { title: "Database", body: "Postgres 17 with Drizzle, typed queries and forward-only migrations." },
      { title: "Authentication", body: "Email and password with roles, sessions and secure cookies." },
      { title: "Production", body: "One Dockerfile and a compose file: run it anywhere you like." },
    ],
  },
  notFound: {
    title: "Page not found",
    body: "The page you are looking for does not exist or has moved.",
    cta: "Back to home",
  },
  error: {
    title: "Something went wrong",
    body: "An unexpected error occurred. Try again, and if it keeps happening, come back later.",
    retry: "Try again",
  },
  loading: "Loading…",
  footer: "All rights reserved.",
} as const;
