COOKIE = "agentorg_page"


def test_a_login_link_sets_an_httponly_strict_cookie_and_opens_the_page(client, login_link):
    response = client.get(login_link, follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/"
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE}=page_1;")
    attributes = {part.strip().lower() for part in cookie.split(";")[1:]}
    assert {"httponly", "samesite=strict", "path=/"} <= attributes
    assert any(attribute.startswith("expires=") for attribute in attributes)

    page = client.get("/")
    assert page.status_code == 200
    assert "Waiting on you" in page.text


def test_a_login_link_works_once(client, login_link):
    assert client.get(login_link, follow_redirects=False).status_code == 303
    client.cookies.clear()

    response = client.get(login_link, follow_redirects=False)

    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    assert "This sign-in link is used or expired." in response.text


def test_the_page_without_a_page_session_is_signed_out(client):
    response = client.get("/")
    assert response.status_code == 401
    assert "Signed out" in response.text
    assert "agentorg ui" in response.text
    assert "www-authenticate" not in response.headers

    client.cookies.set(COOKIE, "page_unknown")
    assert client.get("/").status_code == 401


def test_page_responses_forbid_scripts_framing_and_caching(client, login_link):
    signed_out = client.get("/")
    client.get(login_link)
    signed_in = client.get("/")

    assert (signed_out.status_code, signed_in.status_code) == (401, 200)
    for response in (signed_out, signed_in):
        policy = response.headers["content-security-policy"]
        assert "default-src 'none'" in policy
        assert "frame-ancestors 'none'" in policy
        assert "script-src" not in policy
        assert response.headers["cache-control"] == "no-store"
