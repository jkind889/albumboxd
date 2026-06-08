import {
  RedirectToSignIn,
  Show,
  UserProfile,
} from '@clerk/react'

export function Account() {
  return (
    <>
      <Show when="signed-in">
        <section className="container py-4">
          <h1 className="mb-4">Account</h1>
          <UserProfile />
        </section>
      </Show>

      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  )
}

export default Account
