import { Composition } from "remotion";
import { FragnoOverviewVideo, type FragnoOverviewVideoProps } from "./FragnoOverviewVideo";

export const RemotionRoot = () => {
  return (
    <Composition
      id="FragnoOverviewVideo"
      component={FragnoOverviewVideo}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={600}
      defaultProps={
        {
          appName: "Your existing app",
        } satisfies FragnoOverviewVideoProps
      }
    />
  );
};
