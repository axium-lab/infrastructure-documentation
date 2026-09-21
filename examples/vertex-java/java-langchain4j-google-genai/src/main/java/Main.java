import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.google.genai.GoogleGenAiChatModel;

public class Main {
  public static void main(String[] args) {
    ChatModel model = GoogleGenAiChatModel.builder()
        .googleCredentials(GoogleCredentials.create(
            new AccessToken("ax_34d7b1add3da3ceb7d67e6035ae75183e29b1911", null)))
        .projectId("lo-que-sea")
        .location("global")
        .apiEndpoint("https://axium-core.a.run.app/v1/proxy-apps/686f2125-be80-45f6-b559-f96163924c29/vertex")
        .modelName("google/gemini-3.5-flash-lite")
        .seed(42)
        .build();

    System.out.println(model.chat("Que modelo eres?"));
  }
}
