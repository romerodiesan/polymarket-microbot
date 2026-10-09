export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { passwordProblem } = await import("./lib/auth");
  const problem = passwordProblem();
  if (problem) console[problem.level](`[auth] ${problem.message}`);
}
