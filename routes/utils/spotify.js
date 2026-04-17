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

    const data = await response.json();
    accessToken = data.access_token;
    tokenExpiration = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 minute before expiration

    return accessToken;
    };

module.exports = {
    getSpotifyAccessToken
}