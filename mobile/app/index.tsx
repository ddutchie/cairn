import { Redirect } from "expo-router";

/**
 * App entry. The tabs group no longer has an `index` route (the Projects tab is
 * a named `projects/` directory so its detail screens can nest without the old
 * `index`-folder route collision), so send `/` to the Projects tab explicitly.
 */
export default function Index() {
  return <Redirect href="/projects" />;
}
