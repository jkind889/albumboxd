const express = require("express")

let accessToken = null;
let tokenExpiration = 0;


const getSpotifyAccessToken = async () => {
    if (accessToken && Date.now() < tokenExpiration) {
        return accessToken;
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64")
        },
        body: new URLSearchParams({
            grant_type: "client_credentials"
        })
    });

    if (!response.ok) {
        throw new Error(`Spotify token fetch failed with status ${response.status}`);
    }

    const data = await response.json();

    if (!data.access_token || !data.expires_in) {
        throw new Error("Spotify token response was missing access token data");
    }

    accessToken = data.access_token;
    tokenExpiration = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 minute before expiration

    return accessToken;
    };

module.exports = {
    getSpotifyAccessToken
}
