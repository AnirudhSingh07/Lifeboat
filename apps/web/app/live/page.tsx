import { redirect } from "next/navigation";

// Live mode was merged into the main app (connect → create/open → dashboard).
export default function LiveRedirect() {
  redirect("/app");
}
