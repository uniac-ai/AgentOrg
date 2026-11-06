// Trade the one-time code in this page's fragment for a session, kept in this origin's own
// storage, which no other port's page can read (a cookie would reach every port on 127.0.0.1).
// The fragment never leaves the browser, and it's dropped from the address at once.
const code = location.hash.slice(1);
history.replaceState(null, "", "/signin");
const status = document.getElementById("status");
const again = "Run agentorg open for a new sign-in link.";
if (!code) status.textContent = `This link has no sign-in code. ${again}`;
else
  fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  })
    .then(async (response) => {
      if (!response.ok) {
        status.textContent = `This sign-in link was used already or has expired. ${again}`;
        return;
      }
      const { session } = await response.json();
      localStorage.setItem("agentorg.session", session);
      location.replace("/");
    })
    .catch(() => {
      status.textContent = "AgentOrg isn't answering. Is it still running?";
    });
