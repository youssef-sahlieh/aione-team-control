// Address of the AION proxy (proxy/, on Vercel). Not a secret.
// Remove legacy browser bearer sessions before switching to the isolated cookie host.
try{localStorage.removeItem("aione-session");}catch{}
window.AIONE_API = location.origin + "/api";
if(location.hostname==="youssef-sahlieh.github.io"){
  const page=location.pathname.split("/").pop()||"index.html";
  location.replace("https://aione-team-proxy.vercel.app/"+page+location.search+location.hash);
}
