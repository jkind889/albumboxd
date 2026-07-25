import PopularAlbumsList from "../Components/PopularAlbums";

export function PopularAlbums() {
  return (
    <section className="reviews-page popular-albums-page">
      <section className="reviews-section">
        <div className="reviews-section-header">
          <div>
            <p className="reviews-kicker">Popular albums</p>
            <h1>Most Discussed</h1>
          </div>
          <span className="popular-albums-count">Last 30 days</span>
        </div>

        <PopularAlbumsList limit={10} window="30d" />
      </section>
    </section>
  );
}

export default PopularAlbums;
