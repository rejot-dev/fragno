import { getClient } from "./mod";
import { createBlogPost, createUser } from "./repository";

const libraryClient = await getClient();

const createdUser = await createUser({
  email: "test@example.com",
  name: "Test User",
});

const createdBlogPost = await createBlogPost({
  title: "Hello, world!",
  content: "This is a test post",
  author_id: createdUser.id,
});

const comment = await libraryClient.createComment({
  title: "Hello, world!",
  content: "This is a test post",
  postReference: createdBlogPost.id.toString(),
  userReference: createdUser.id.toString(),
});

console.log(comment);

const comments = await libraryClient.getComments(createdBlogPost.id.toString());
console.log(comments);

console.log("Done");
